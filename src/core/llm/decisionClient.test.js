import { afterEach, describe, expect, it, vi } from 'vitest';
import { DecisionClient, choice, score, noul } from './decisionClient.js';
import { createClient } from './clients.js';
import { createLLMService } from './llm.js';

const okJson = (value) => ({ ok: true, json: async () => value });
afterEach(() => vi.useRealTimers());

describe('decision question helpers', () => {
  it('builds choice, score, and noul questions without flattening instructions', () => {
    expect(choice({ text: 'Route this' }, ['returns', 'billing'])).toEqual({
      type: 'choice',
      instructions: { text: 'Route this' },
      criteria: { returns: null, billing: null },
    });
    expect(score('Priority?', ['Routine', 'Urgent']).criteria).toEqual(['Routine', 'Urgent']);
    expect(noul('Replace?', { trueDescription: 'Damaged' }).criteria).toEqual({
      true: 'Damaged',
      false: null,
    });
    expect(noul('Replace?')).not.toHaveProperty('criteria');
  });

  it('rejects duplicate choices, invalid descriptions, and invalid score levels', () => {
    for (const criteria of [[], ['same', 'same'], [1], { bad: 2 }]) {
      expect(() => choice('?', criteria)).toThrow();
    }
    for (const criteria of [['one'], Array(11).fill('level'), [1, 2], 'bad']) {
      expect(() => score('?', criteria)).toThrow();
    }
    expect(() => noul('?', { falseDescription: false })).toThrow();
  });
});

describe('DecisionClient', () => {
  it.each(['http://localhost:8080/proxy', 'http://localhost:8080/proxy/v1/'])(
    'normalizes %s and sends the decision wire format with optional inputs',
    async (baseUrl) => {
      const response = {
        answers: { ok: { noul: 0.83 } },
        model: 'test',
        usage: { total_tokens: 12 },
      };
      const transport = vi.fn().mockResolvedValue(okJson(response));
      const client = new DecisionClient({ baseUrl, model: 'default', apiKey: 'secret', transport });
      const questions = { ok: noul('Accept?') };
      const images = ['data:image/png;base64,YQ=='];
      const result = await client.decide({ text: 'Example' }, questions, {
        model: 'override',
        images,
        files: [],
      });
      expect(result).toBe(response);
      const [url, options] = transport.mock.calls[0];
      expect(url).toBe('http://localhost:8080/proxy/v1/systemone');
      expect(options.method).toBe('POST');
      expect(options.headers.Authorization).toBe('Bearer secret');
      expect(JSON.parse(options.body)).toEqual({
        state: { text: 'Example' },
        questions,
        model: 'override',
        images,
        files: [],
      });
    },
  );

  it('reports provider, model, sizes, and usage to the metrics collector', async () => {
    const response = {
      answers: { ok: { noul: 0.5 } },
      model: 'served-model',
      usage: { prompt_tokens: 40, completion_tokens: 2, total_tokens: 42 },
    };
    const transport = vi.fn().mockResolvedValue(okJson(response));
    const client = new DecisionClient({ baseUrl: 'http://localhost:8080', transport });
    const metricsCollector = vi.fn();

    await client.decide('state', { ok: noul('?') }, { metricsCollector });

    expect(metricsCollector).toHaveBeenCalledWith({
      provider: 'llama_decision',
      model: 'served-model',
      requestChars: transport.mock.calls[0][1].body.length,
      responseChars: JSON.stringify(response).length,
      usage: { inputTokens: 40, outputTokens: 2, totalTokens: 42 },
    });
  });

  it('uses GET for models and omits unset model and credentials for decisions', async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce(okJson({ data: [{ id: 'local' }] }))
      .mockResolvedValueOnce(okJson({ answers: {} }));
    const client = createClient(
      { type: 'llama_decision', url: 'http://localhost:8080' },
      { transport },
    );
    expect(await client.listModels()).toEqual({ data: [{ id: 'local' }] });
    expect(transport.mock.calls[0][0]).toBe('http://localhost:8080/v1/models');
    expect(transport.mock.calls[0][1]).toMatchObject({
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    expect(transport.mock.calls[0][1]).not.toHaveProperty('body');
    await client.decide('state', { ok: noul('?') });
    expect(JSON.parse(transport.mock.calls[1][1].body)).not.toHaveProperty('model');
    expect(transport.mock.calls[1][1].headers).not.toHaveProperty('Authorization');
  });

  it('retains HTTP status, original body, and parsed server error', async () => {
    const body = '{"error":"model unavailable"}';
    const transport = vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => body });
    await expect(new DecisionClient({ transport }).listModels()).rejects.toMatchObject({
      status: 503,
      body,
      response: { error: 'model unavailable' },
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each([null, [], {}, { answers: [] }])(
    'rejects malformed decision response %j',
    async (response) => {
      const client = new DecisionClient({ transport: vi.fn().mockResolvedValue(okJson(response)) });
      await expect(client.decide('state', { ok: noul('?') })).rejects.toThrow(/response/i);
    },
  );

  it('reports invalid JSON and propagates network errors', async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => {
          throw new SyntaxError('bad json');
        },
      })
      .mockRejectedValueOnce(new Error('network down'));
    const client = new DecisionClient({ transport });
    await expect(client.listModels()).rejects.toThrow('invalid JSON');
    await expect(client.listModels()).rejects.toThrow('network down');
  });

  it('validates questions and data URLs before making a request', async () => {
    const transport = vi.fn();
    const client = new DecisionClient({ transport });
    for (const questions of [{}, [], { '': {} }, { bad: [] }]) {
      await expect(client.decide('state', questions)).rejects.toThrow(/Questions/);
    }
    await expect(
      client.decide('state', { ok: noul('?') }, { images: ['path.png'] }),
    ).rejects.toThrow(/data URLs/);
    await expect(
      client.decide('state', { ok: noul('?') }, { files: 'data:text/plain,x' }),
    ).rejects.toThrow(/data URLs/);
    expect(transport).not.toHaveBeenCalled();
  });

  it('rejects unsafe token transport and invalid URLs or timeouts', () => {
    expect(
      () => new DecisionClient({ baseUrl: 'http://remote.example', apiKey: 'secret' }),
    ).toThrow(/non-HTTPS/);
    for (const baseUrl of ['ftp://server', 'http://server?key=secret', 'http://server#fragment']) {
      expect(() => new DecisionClient({ baseUrl })).toThrow();
    }
    for (const timeout of [0, -1, NaN, Infinity, true]) {
      expect(() => new DecisionClient({ timeout })).toThrow(/Timeout/);
    }
  });

  it('honors caller cancellation and cleans up its timeout', async () => {
    vi.useFakeTimers();
    const transport = vi.fn(
      (_url, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );
    const caller = new AbortController();
    const pending = new DecisionClient({ transport }).listModels({ signal: caller.signal });
    const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    caller.abort();
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out each request and avoids sending already aborted requests', async () => {
    vi.useFakeTimers();
    const transport = vi.fn(
      (_url, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );
    const client = new DecisionClient({ transport, timeout: 0.1 });
    const assertion = expect(client.listModels()).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    const caller = new AbortController();
    caller.abort();
    await expect(client.listModels({ signal: caller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects completion requests without retries or HTTP calls', async () => {
    const transport = vi.fn();
    const service = createLLMService({
      transport,
      getRequestTimeoutSeconds: async () => 60,
      getVerboseLogs: async () => false,
      logWarn: vi.fn(),
    });
    const result = await service.callLLMDirectWithRetry({
      prompt: 'Summarize',
      provider: { type: 'llama_decision', url: 'http://localhost:8080' },
    });
    expect(result).toMatchObject({
      ok: false,
      retryable: false,
      error: expect.stringContaining('structured decisions only'),
    });
    expect(transport).not.toHaveBeenCalled();
  });
});
