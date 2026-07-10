import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const OPENAI_COMP_PROVIDER = {
  id: 'p1',
  name: 'Local',
  type: 'openai_comp',
  model: 'gpt-oss-20B',
  token: '',
  url: 'http://192.168.0.147:8989',
};

const EXPECTED_ENDPOINT = 'http://192.168.0.147:8989/v1/chat/completions';

function stubChrome(state, { verboseLogs = false } = {}) {
  vi.stubGlobal('chrome', {
    runtime: { lastError: undefined },
    storage: {
      local: {
        get: (keys, cb) => {
          const items = { 'pagetollm:llm:providers': state };
          if (verboseLogs) items['pagetollm-verbose-logs'] = true;
          cb(items);
        },
      },
    },
  });
}

function stubActiveProvider(provider = OPENAI_COMP_PROVIDER, options = {}) {
  stubChrome({ providers: [provider], activeId: provider.id }, options);
}

async function getLLM() {
  vi.resetModules();
  return await import('./llm.js');
}

describe('callLLMDirect', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubActiveProvider();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('returns an error when no provider is configured', async () => {
    stubChrome({ providers: [], activeId: null });
    const { callLLMDirect } = await getLLM();
    const res = await callLLMDirect({ prompt: 'hello' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('No LLM provider configured');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns an error when provider lookup throws', async () => {
    vi.stubGlobal('chrome', {
      runtime: { lastError: undefined },
      storage: {
        local: {
          get: (_keys, cb) => {
            chrome.runtime.lastError = { message: 'storage unavailable' };
            cb({});
          },
        },
      },
    });
    const { callLLMDirect } = await getLLM();
    const res = await callLLMDirect({ prompt: 'hello' });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('storage unavailable');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('calls the active provider endpoint and strips <think> tags', async () => {
    const { callLLMDirect } = await getLLM();
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          { message: { content: '<think>reason</think>This is the final response text.' } },
        ],
      }),
    });

    const res = await callLLMDirect({ prompt: 'hello' });
    expect(res).toEqual({ ok: true, content: 'This is the final response text.' });

    expect(fetch).toHaveBeenCalledWith(
      EXPECTED_ENDPOINT,
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-oss-20B',
          messages: [{ role: 'user', content: 'hello' }],
          temperature: 0.8,
          cache_prompt: true,
        }),
      }),
    );
  });

  it('reports normalized provider usage to the metrics collector', async () => {
    const { callLLMDirect } = await getLLM();
    const metricsCollector = vi.fn();
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: 'result' } }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 10,
          total_tokens: 110,
          prompt_tokens_details: { cached_tokens: 75 },
        },
      }),
    });

    await expect(callLLMDirect({ prompt: 'hello', metricsCollector })).resolves.toEqual({
      ok: true,
      content: 'result',
    });
    expect(metricsCollector).toHaveBeenCalledWith({
      provider: 'openai-compatible',
      model: 'gpt-oss-20B',
      requestChars: 5,
      responseChars: 6,
      usage: {
        inputTokens: 100,
        outputTokens: 10,
        totalTokens: 110,
        cacheReadTokens: 75,
        cacheMissTokens: 25,
      },
    });
  });

  it('strips various forms of <think> tags', async () => {
    const { callLLMDirect } = await getLLM();
    const variations = [
      '<think>a</think>test',
      "<think class='x'>a</think>test",
      '<THINK>a</THINK>test',
      '<think>\na\n</think>test',
      '<think>a\nb</think>test',
      '<think   >a</think>test',
      '<think attr1="a" attr2="b">thinking</think>test',
      '<think></think>test',
    ];

    for (const content of variations) {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content } }] }),
      });
      const res = await callLLMDirect({ prompt: 'hello' });
      expect(res.content).toBe('test');
    }
  });

  it('returns error on non-ok HTTP status', async () => {
    const { callLLMDirect } = await getLLM();
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'Internal server error',
    });

    const res = await callLLMDirect({ prompt: 'hello' });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('LLM HTTP 500: Internal server error');
  });

  it('slices error response text to 300 characters', async () => {
    const { callLLMDirect } = await getLLM();
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'a'.repeat(400),
    });

    const res = await callLLMDirect({ prompt: 'hello' });
    expect(res.error).toBe(`LLM HTTP 500: ${'a'.repeat(300)}`);
  });

  it('returns error on empty/whitespace content', async () => {
    const { callLLMDirect } = await getLLM();
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '   ' } }] }),
    });

    const res = await callLLMDirect({ prompt: 'hello' });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('Empty LLM response');
  });

  it('returns error when content is not a string', async () => {
    const { callLLMDirect } = await getLLM();
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: null } }] }),
    });

    const res = await callLLMDirect({ prompt: 'hello' });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('Empty LLM response');
  });

  it('handles timeout abort error gracefully', async () => {
    const { callLLMDirect } = await getLLM();
    vi.mocked(fetch).mockRejectedValue({
      name: 'AbortError',
      message: 'The operation was aborted.',
    });

    const res = await callLLMDirect({ prompt: 'hello' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('timed out');
  });

  it('throws AbortError when the caller signal aborts an in-flight request', async () => {
    const { callLLMDirect } = await getLLM();
    const controller = new AbortController();
    vi.mocked(fetch).mockImplementation((_url, init) => {
      if (init.signal.aborted) {
        return Promise.reject({ name: 'AbortError', message: 'The operation was aborted.' });
      }
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          reject({ name: 'AbortError', message: 'The operation was aborted.' });
        });
      });
    });

    const request = callLLMDirect({ prompt: 'hello', signal: controller.signal });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    controller.abort();

    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('callLLM preserves AbortError from a caller signal', async () => {
    const { callLLM } = await getLLM();
    const controller = new AbortController();
    vi.mocked(fetch).mockImplementation((_url, init) => {
      if (init.signal.aborted) {
        return Promise.reject({ name: 'AbortError', message: 'The operation was aborted.' });
      }
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          reject({ name: 'AbortError', message: 'The operation was aborted.' });
        });
      });
    });

    const request = callLLM({ prompt: 'hello', signal: controller.signal });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    controller.abort();

    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('handles generic fetch error', async () => {
    const { callLLMDirect } = await getLLM();
    vi.mocked(fetch).mockRejectedValue(new Error('Connection refused'));

    const res = await callLLMDirect({ prompt: 'hello' });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('Connection refused');
    expect(console.warn).toHaveBeenCalledWith(
      'PageToLLM Canvas LLM request failed:',
      'Connection refused',
    );
  });

  it('omits request/response console.info when verbose logs are off', async () => {
    const { callLLMDirect } = await getLLM();
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
    });

    await callLLMDirect({ prompt: 'hello' });
    expect(console.info).not.toHaveBeenCalled();
  });

  it('logs request/response console.info when verbose logs are on', async () => {
    stubActiveProvider(OPENAI_COMP_PROVIDER, { verboseLogs: true });
    const { callLLMDirect } = await getLLM();
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
    });

    await callLLMDirect({ prompt: 'hello' });
    expect(console.info).toHaveBeenCalledWith(
      'PageToLLM Canvas LLM request:',
      expect.objectContaining({
        provider: 'Local',
        type: 'openai_comp',
        model: 'gpt-oss-20B',
        promptLength: 5,
      }),
    );
    expect(console.info).toHaveBeenCalledWith(
      'PageToLLM Canvas LLM response:',
      expect.objectContaining({
        endpoint: EXPECTED_ENDPOINT,
        responseLength: 2,
      }),
    );
  });

  it('routes to the Anthropic Messages API for anthropic providers', async () => {
    stubActiveProvider({
      id: 'a1',
      name: 'Claude',
      type: 'anthropic',
      model: 'claude-haiku-4-5',
      token: 'sk-ant-test',
    });
    const { callLLMDirect } = await getLLM();
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ content: [{ type: 'text', text: 'Claude says hi' }] }),
    });

    const res = await callLLMDirect({ prompt: 'hello' });
    expect(res).toEqual({ ok: true, content: 'Claude says hi' });

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.headers['x-api-key']).toBe('sk-ant-test');
    expect(init.headers['anthropic-dangerous-direct-browser-access']).toBe('true');
  });

  it('returns error for unsupported provider type', async () => {
    stubActiveProvider({ id: 'x', name: 'X', type: 'openai_comp', model: 'm', url: '' });
    const { callLLMDirect } = await getLLM();
    const res = await callLLMDirect({ prompt: 'hello' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('requires a base URL');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('clears the fallback abort timeout after a successful call', async () => {
    const originalTimeout = AbortSignal.timeout;
    Object.defineProperty(AbortSignal, 'timeout', { value: undefined, configurable: true });
    const { callLLMDirect } = await getLLM();
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'Success' } }] }),
    });

    try {
      await callLLMDirect({ prompt: 'hello' });
      expect(fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
      expect(clearSpy).toHaveBeenCalled();
    } finally {
      Object.defineProperty(AbortSignal, 'timeout', {
        value: originalTimeout,
        configurable: true,
      });
    }
  });
});

describe('callLLM', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubActiveProvider();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('returns response content string', async () => {
    const { callLLM } = await getLLM();
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'Response' } }] }),
    });

    const content = await callLLM({ prompt: 'hello' });
    expect(content).toBe('Response');
  });

  it('throws error on failure', async () => {
    const { callLLM } = await getLLM();
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'Bad request',
    });

    await expect(callLLM({ prompt: 'hello' })).rejects.toThrow('LLM HTTP 400: Bad request');
  });
});

describe('callLLMWithRetry', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn) => {
      fn();
      return 0;
    });
    stubActiveProvider();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('succeeds on first attempt', async () => {
    const { callLLMWithRetry } = await getLLM();
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'Success' } }] }),
    });

    const content = await callLLMWithRetry({ prompt: 'hello' }, 3);
    expect(content).toBe('Success');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('retries and succeeds on third attempt', async () => {
    const { callLLMWithRetry } = await getLLM();
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'Error 1' })
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'Error 2' })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'Success' } }] }),
      });

    const content = await callLLMWithRetry({ prompt: 'hello' }, 3);
    expect(content).toBe('Success');
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('fails after exhausting max retries', async () => {
    const { callLLMWithRetry } = await getLLM();
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'Error',
    });

    await expect(callLLMWithRetry({ prompt: 'hello' }, 2)).rejects.toThrow('LLM HTTP 500: Error');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('aborts during retry backoff without waiting for the timer', async () => {
    vi.restoreAllMocks();
    vi.stubGlobal('fetch', vi.fn());
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubActiveProvider();

    let resolveTimeoutScheduled;
    const timeoutScheduled = new Promise((resolve) => {
      resolveTimeoutScheduled = resolve;
    });
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn) => {
      resolveTimeoutScheduled(fn);
      return 1;
    });
    vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => {});

    const { callLLMWithRetry } = await getLLM();
    const controller = new AbortController();
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'Error',
    });

    const request = callLLMWithRetry({ prompt: 'hello', signal: controller.signal }, 3);
    await timeoutScheduled;
    controller.abort();

    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('parallelMap', () => {
  it('maps elements in parallel under concurrency limit', async () => {
    const { parallelMap } = await getLLM();
    const items = [1, 2, 3, 4, 5];
    const log = [];
    const fn = async (x) => {
      log.push(`start ${x}`);
      await new Promise((r) => setTimeout(r, 10));
      log.push(`end ${x}`);
      return x * 2;
    };

    const res = await parallelMap(items, 2, fn);
    expect(res).toEqual([2, 4, 6, 8, 10]);
    expect(log[0]).toBe('start 1');
    expect(log[1]).toBe('start 2');

    const start3Index = log.indexOf('start 3');
    const end1Index = log.indexOf('end 1');
    const end2Index = log.indexOf('end 2');
    expect(start3Index).toBeGreaterThan(Math.min(end1Index, end2Index));
  });

  it('handles empty items array', async () => {
    const { parallelMap } = await getLLM();
    const res = await parallelMap([], 2, async (x) => x);
    expect(res).toEqual([]);
  });

  it('runs the first item to completion before the concurrent burst when warmupFirst', async () => {
    const { parallelMap } = await getLLM();
    const items = [1, 2, 3, 4, 5];
    const log = [];
    const fn = async (x) => {
      log.push(`start ${x}`);
      await new Promise((r) => setTimeout(r, 10));
      log.push(`end ${x}`);
      return x * 2;
    };

    const res = await parallelMap(items, 2, fn, { warmupFirst: true });
    expect(res).toEqual([2, 4, 6, 8, 10]);
    // The lead item finishes entirely before anything else starts.
    expect(log.slice(0, 2)).toEqual(['start 1', 'end 1']);
    expect(log.indexOf('start 2')).toBeGreaterThan(log.indexOf('end 1'));
  });

  it('does not warm up a single-item list (keeps it in the parallel phase)', async () => {
    const { parallelMap } = await getLLM();
    const order = [];
    const fn = async (x) => {
      order.push(x);
      return x;
    };
    const res = await parallelMap([1], 4, fn, { warmupFirst: true });
    expect(res).toEqual([1]);
    expect(order).toEqual([1]);
  });
});

describe('createLimiter', () => {
  it('never runs more tasks than the limit concurrently', async () => {
    const { createLimiter } = await getLLM();
    const limit = createLimiter(2);
    let active = 0;
    let maxActive = 0;
    const task = async (x) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return x * 2;
    };

    const res = await Promise.all([1, 2, 3, 4, 5].map((x) => limit(() => task(x))));
    expect(res).toEqual([2, 4, 6, 8, 10]);
    expect(maxActive).toBe(2);
  });

  it('propagates rejections and keeps admitting queued tasks', async () => {
    const { createLimiter } = await getLLM();
    const limit = createLimiter(1);
    const order = [];

    const failing = limit(async () => {
      order.push('fail');
      throw new Error('boom');
    });
    const succeeding = limit(async () => {
      order.push('ok');
      return 42;
    });

    await expect(failing).rejects.toThrow('boom');
    await expect(succeeding).resolves.toBe(42);
    expect(order).toEqual(['fail', 'ok']);
  });

  it('runs queued tasks in FIFO order under a limit of 1', async () => {
    const { createLimiter } = await getLLM();
    const limit = createLimiter(1);
    const order = [];
    await Promise.all(
      [1, 2, 3].map((x) =>
        limit(async () => {
          order.push(x);
          await new Promise((r) => setTimeout(r, 5));
        }),
      ),
    );
    expect(order).toEqual([1, 2, 3]);
  });
});

describe('exports', () => {
  it('exports a positive LLM_REQUEST_TIMEOUT_MS number', async () => {
    const { LLM_REQUEST_TIMEOUT_MS } = await getLLM();
    expect(typeof LLM_REQUEST_TIMEOUT_MS).toBe('number');
    expect(LLM_REQUEST_TIMEOUT_MS).toBeGreaterThan(0);
  });
});
