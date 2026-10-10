import { afterEach, describe, expect, it, vi } from 'vitest';
import { DecisionClient, choice } from './decisionClient.js';

const okJson = (value) => ({ ok: true, json: async () => value });
const question = () => choice('Split here?', { split: null, continue: 'Same topic' });
afterEach(() => vi.useRealTimers());

describe('choice', () => {
  it('builds a choice question without flattening instructions', () => {
    expect(choice({ text: 'Route this' }, { returns: null, billing: 'Payments' })).toEqual({
      type: 'choice',
      instructions: { text: 'Route this' },
      criteria: { returns: null, billing: 'Payments' },
    });
  });

  it('rejects empty, array, or invalid descriptions', () => {
    for (const criteria of [{}, ['a', 'b'], { bad: 2 }, { '': null }, null]) {
      expect(() => choice('?', criteria)).toThrow();
    }
  });
});

describe('DecisionClient', () => {
  it('preserves Retry-After for the reusable decision executor', async () => {
    const transport = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => 'busy',
      headers: { get: (name) => (name === 'Retry-After' ? '7' : null) },
    });
    await expect(
      new DecisionClient({ transport }).decide('state', { ok: question() }),
    ).rejects.toMatchObject({ status: 429, retryAfterMs: 7000 });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it.each(['http://localhost:8080/proxy', 'http://localhost:8080/proxy/v1/'])(
    'normalizes %s and sends the decision wire format',
    async (baseUrl) => {
      const response = {
        answers: { ok: { choice: 'split' } },
        model: 'test',
        usage: { total_tokens: 12 },
      };
      const transport = vi.fn().mockResolvedValue(okJson(response));
      const client = new DecisionClient({ baseUrl, model: 'default', apiKey: 'secret', transport });
      const questions = { ok: question() };
      const result = await client.decide({ text: 'Example' }, questions, { model: 'override' });
      expect(result).toBe(response);
      const [url, options] = transport.mock.calls[0];
      expect(url).toBe('http://localhost:8080/proxy/v1/systemone');
      expect(options.method).toBe('POST');
      expect(options.headers.Authorization).toBe('Bearer secret');
      expect(JSON.parse(options.body)).toEqual({
        state: { text: 'Example' },
        questions,
        model: 'override',
      });
    },
  );

  it('reports provider, model, sizes, and usage to the metrics collector', async () => {
    const response = {
      answers: { ok: { choice: 'split' } },
      model: 'served-model',
      usage: { prompt_tokens: 40, completion_tokens: 2, total_tokens: 42 },
    };
    const transport = vi.fn().mockResolvedValue(okJson(response));
    const client = new DecisionClient({ baseUrl: 'http://localhost:8080', transport });
    const metricsCollector = vi.fn();

    await client.decide('state', { ok: question() }, { metricsCollector });

    expect(metricsCollector).toHaveBeenCalledWith({
      provider: 'llama_decision',
      model: 'served-model',
      requestChars: transport.mock.calls[0][1].body.length,
      responseChars: JSON.stringify(response).length,
      usage: { inputTokens: 40, outputTokens: 2, totalTokens: 42 },
    });
  });

  it('omits unset model and credentials', async () => {
    const transport = vi.fn().mockResolvedValue(okJson({ answers: {} }));
    await new DecisionClient({ transport }).decide('state', { ok: question() });
    expect(JSON.parse(transport.mock.calls[0][1].body)).not.toHaveProperty('model');
    expect(transport.mock.calls[0][1].headers).not.toHaveProperty('Authorization');
  });

  it('retains HTTP status, original body, and parsed server error', async () => {
    const body = '{"error":"model unavailable"}';
    const transport = vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => body });
    await expect(
      new DecisionClient({ transport }).decide('state', { ok: question() }),
    ).rejects.toMatchObject({
      status: 503,
      body,
      response: { error: 'model unavailable' },
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('logs the raw request and response only when verbose logs are enabled', async () => {
    const response = { answers: { ok: { choice: 'split' } }, extra: 'kept' };
    const logger = { info: vi.fn() };
    const transport = vi.fn().mockResolvedValue(okJson(response));
    const client = new DecisionClient({ transport, logger, apiKey: 'secret', model: 'm' });

    await client.decide('state', { ok: question() });
    expect(logger.info).not.toHaveBeenCalled();

    await client.decide('state', { ok: question() }, { verboseLogs: true });
    expect(logger.info).toHaveBeenCalledWith('request:', {
      endpoint: 'http://localhost:8080/v1/systemone',
      method: 'POST',
      body: { state: 'state', questions: { ok: question() }, model: 'm' },
    });
    expect(logger.info).toHaveBeenCalledWith('raw response data:', response);
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain('secret');
  });

  it('logs the raw HTTP error body when verbose logs are enabled', async () => {
    const logger = { info: vi.fn() };
    const body = '{"error":"model unavailable"}';
    const transport = vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => body });
    await expect(
      new DecisionClient({ transport, logger }).decide(
        'state',
        { ok: question() },
        { verboseLogs: true },
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(logger.info).toHaveBeenCalledWith('raw error response:', {
      endpoint: 'http://localhost:8080/v1/systemone',
      status: 503,
      body,
    });
  });

  it.each([null, [], {}, { answers: [] }])(
    'rejects malformed decision response %j',
    async (response) => {
      const client = new DecisionClient({ transport: vi.fn().mockResolvedValue(okJson(response)) });
      await expect(client.decide('state', { ok: question() })).rejects.toThrow(/response/i);
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
    await expect(client.decide('state', { ok: question() })).rejects.toThrow('invalid JSON');
    await expect(client.decide('state', { ok: question() })).rejects.toThrow('network down');
  });

  it('validates questions before making a request', async () => {
    const transport = vi.fn();
    const client = new DecisionClient({ transport });
    for (const questions of [{}, [], { '': {} }, { bad: [] }]) {
      await expect(client.decide('state', questions)).rejects.toThrow(/Questions/);
    }
    expect(transport).not.toHaveBeenCalled();
  });

  it('rejects unsafe token transport and invalid URLs or timeouts', () => {
    expect(
      () => new DecisionClient({ baseUrl: 'http://remote.example', apiKey: 'secret' }),
    ).toThrow(/requires an HTTPS/);
    expect(
      () => new DecisionClient({ baseUrl: 'http://127.0.0.1:8080', apiKey: 'secret' }),
    ).not.toThrow();
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
    const pending = new DecisionClient({ transport }).decide(
      'state',
      { ok: question() },
      { signal: caller.signal },
    );
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
    const assertion = expect(client.decide('state', { ok: question() })).rejects.toMatchObject({
      name: 'TimeoutError',
    });
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    const caller = new AbortController();
    caller.abort();
    await expect(
      client.decide('state', { ok: question() }, { signal: caller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
