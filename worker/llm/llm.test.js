import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DEFAULT_LLM_REQUEST_TIMEOUT_SECONDS } from '../settings/llmTimeout.js';

const OPENAI_COMP_PROVIDER = {
  id: 'p1',
  name: 'Local',
  type: 'openai_comp',
  model: 'gpt-oss-20B',
  token: '',
  url: 'http://192.168.0.147:8989',
};

const EXPECTED_ENDPOINT = 'http://192.168.0.147:8989/v1/chat/completions';

function stubChrome(state, { verboseLogs = false, requestTimeoutSeconds } = {}) {
  vi.stubGlobal('chrome', {
    runtime: { lastError: undefined },
    storage: {
      local: {
        get: (keys, cb) => {
          const items = { 'pagetollm:llm:providers': state };
          if (verboseLogs) items['pagetollm-verbose-logs'] = true;
          if (requestTimeoutSeconds !== undefined) {
            items['pagetollm-llm-request-timeout-seconds'] = requestTimeoutSeconds;
          }
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
    expect(res).toEqual({
      ok: true,
      content: 'This is the final response text.',
      reasoning: 'reason',
    });

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

  it('returns llama.cpp tool calls without requiring text content', async () => {
    const { callLLMDirect } = await getLLM();
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: '',
              tool_calls: [
                {
                  id: 'c1',
                  function: {
                    name: 'highlight_span',
                    arguments: '{"start_line":1,"end_line":2}',
                  },
                },
              ],
            },
          },
        ],
      }),
    });

    await expect(
      callLLMDirect({
        messages: [{ role: 'user', content: 'question' }],
        tools: [{ name: 'highlight_span', parameters: { type: 'object' } }],
      }),
    ).resolves.toEqual({
      ok: true,
      content: '',
      toolCalls: [
        {
          id: 'c1',
          name: 'highlight_span',
          arguments: { start_line: 1, end_line: 2 },
        },
      ],
    });
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

  it('uses the configured request timeout', async () => {
    stubActiveProvider(OPENAI_COMP_PROVIDER, { requestTimeoutSeconds: 600 });
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const { callLLMDirect } = await getLLM();
    vi.mocked(fetch).mockRejectedValue({
      name: 'AbortError',
      message: 'The operation was aborted.',
    });

    const res = await callLLMDirect({ prompt: 'hello' });

    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 600_000);
    expect(res.error).toBe('LLM request timed out after 600000ms');
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

    let resolveBackoffScheduled;
    const backoffScheduled = new Promise((resolve) => {
      resolveBackoffScheduled = resolve;
    });
    let scheduledTimeouts = 0;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn) => {
      scheduledTimeouts++;
      // callLLMDirect first installs its per-request timeout. The retry loop
      // installs the backoff timer only after that request has failed; wait for
      // this second timer so the test actually aborts during backoff rather
      // than racing the provider failure itself.
      if (scheduledTimeouts === 2) resolveBackoffScheduled(fn);
      return scheduledTimeouts;
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
    await backoffScheduled;
    controller.abort();

    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not retry a non-retryable 4xx status', async () => {
    const { callLLMWithRetry } = await getLLM();
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
      headers: { get: () => null },
    });

    await expect(callLLMWithRetry({ prompt: 'hello' }, 3)).rejects.toThrow(
      'LLM HTTP 401: Unauthorized',
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('retries a 429 (rate limit) status', async () => {
    const { callLLMWithRetry } = await getLLM();
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => 'Rate limited',
        headers: { get: () => null },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'Success' } }] }),
      });

    const content = await callLLMWithRetry({ prompt: 'hello' }, 3);
    expect(content).toBe('Success');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('honors Retry-After for the backoff delay', async () => {
    const setTimeoutDelays = [];
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn, ms) => {
      setTimeoutDelays.push(ms);
      fn();
      return 0;
    });
    const { callLLMWithRetry } = await getLLM();
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => 'Rate limited',
        headers: { get: (name) => (name === 'Retry-After' ? '2' : null) },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'Success' } }] }),
      });

    const content = await callLLMWithRetry({ prompt: 'hello' }, 3);
    expect(content).toBe('Success');
    // Each request-timeout signal also schedules a setTimeout; filter the
    // default-derived delay out to isolate the retry backoff, which should be
    // the Retry-After value (2000ms) since it exceeds the attempt-0 jitter range.
    const defaultRequestTimeoutMs = DEFAULT_LLM_REQUEST_TIMEOUT_SECONDS * 1000;
    const backoffDelays = setTimeoutDelays.filter((ms) => ms !== defaultRequestTimeoutMs);
    expect(backoffDelays).toEqual([2000]);
  });

  it('makes exactly one attempt when maxRetries is 0', async () => {
    const { callLLMWithRetry } = await getLLM();
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'Error',
      headers: { get: () => null },
    });

    await expect(callLLMWithRetry({ prompt: 'hello' }, 0)).rejects.toThrow('LLM HTTP 500: Error');
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

  it('stops claiming new items once one item rejects, but lets in-flight items finish', async () => {
    const { parallelMap } = await getLLM();
    const items = [1, 2, 3, 4];
    const calls = [];
    const err = new Error('item 1 failed');
    let rejectFirst;
    let resolveSecond;

    const fn = vi.fn((x) => {
      calls.push(x);
      if (x === 1) return new Promise((_resolve, reject) => (rejectFirst = reject));
      if (x === 2) return new Promise((resolve) => (resolveSecond = () => resolve(20)));
      return Promise.resolve(x * 10);
    });

    const mapPromise = parallelMap(items, 2, fn);
    // Attach the rejection handler now, before triggering the failure below,
    // so the promise is never briefly unobserved (which Node flags as an
    // unhandled rejection even when a handler follows shortly after).
    const assertion = expect(mapPromise).rejects.toBe(err);
    // Both workers claim their first item synchronously (no await before the
    // first fn call), so items 1 and 2 are in flight immediately.
    expect(calls).toEqual([1, 2]);

    rejectFirst(err);
    // Let item 1's rejection propagate and flip `failed` before item 2's
    // worker loops back to (not) claim a new item.
    await new Promise((r) => setTimeout(r, 0));

    resolveSecond();

    await assertion;
    // Items 3 and 4 were never started once the failure was recorded.
    expect(calls).toEqual([1, 2]);
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

  it('releases the slot and admits the next task before settling the completed task', async () => {
    const { createLimiter } = await getLLM();
    const limit = createLimiter(1);
    let releaseFirst;
    let secondStarted = false;

    const first = limit(
      () =>
        new Promise((resolve) => {
          releaseFirst = resolve;
        }),
    );
    const second = limit(async () => {
      secondStarted = true;
      return 'second';
    });

    await vi.waitFor(() => expect(releaseFirst).toBeTypeOf('function'));
    releaseFirst('first');

    await expect(first).resolves.toBe('first');
    expect(secondStarted).toBe(true);
    await expect(second).resolves.toBe('second');
  });

  it('releases the slot before propagating a task rejection', async () => {
    const { createLimiter } = await getLLM();
    const limit = createLimiter(1);
    const failure = new Error('first failed');
    let rejectFirst;
    let secondStarted = false;

    const first = limit(
      () =>
        new Promise((_resolve, reject) => {
          rejectFirst = reject;
        }),
    );
    const firstAssertion = expect(first).rejects.toBe(failure);
    const second = limit(async () => {
      secondStarted = true;
      return 'second';
    });

    await vi.waitFor(() => expect(rejectFirst).toBeTypeOf('function'));
    rejectFirst(failure);

    await firstAssertion;
    expect(secondStarted).toBe(true);
    await expect(second).resolves.toBe('second');
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

  it('treats a limit of 0 or NaN as a limit of 1 instead of stalling forever', async () => {
    const { createLimiter } = await getLLM();
    for (const badLimit of [0, NaN]) {
      const limit = createLimiter(badLimit);
      let active = 0;
      let maxActive = 0;
      const task = async (x) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return x;
      };

      const res = await Promise.all([1, 2, 3].map((x) => limit(() => task(x))));
      expect(res).toEqual([1, 2, 3]);
      expect(maxActive).toBe(1);
    }
  });
});

describe('createAdjustableLimiter', () => {
  it('applies a lower limit to queued tasks without replacing the queue', async () => {
    const { createAdjustableLimiter } = await getLLM();
    const limiter = createAdjustableLimiter(2);
    const releases = [];
    const started = [];
    const task = (id) =>
      limiter.run(
        () =>
          new Promise((resolve) => {
            started.push(id);
            releases[id] = resolve;
          }),
      );

    const tasks = [task(0), task(1), task(2), task(3)];
    await vi.waitFor(() => expect(started).toEqual([0, 1]));

    limiter.setLimit(1);
    releases[0]();
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual([0, 1]);

    releases[1]();
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2]));
    releases[2]();
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2, 3]));
    releases[3]();
    await Promise.all(tasks);
  });

  it('raises the limit and admits queued tasks immediately', async () => {
    const { createAdjustableLimiter } = await getLLM();
    const limiter = createAdjustableLimiter(1);
    const releases = [];
    const started = [];
    const task = (id) =>
      limiter.run(
        () =>
          new Promise((resolve) => {
            started.push(id);
            releases[id] = resolve;
          }),
      );

    const tasks = [task(0), task(1), task(2)];
    await vi.waitFor(() => expect(started).toEqual([0]));
    limiter.setLimit(3);
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2]));
    releases.forEach((release) => release());
    await Promise.all(tasks);
  });

  it('rejects with AbortError and never calls fn when the signal is already aborted', async () => {
    const { createAdjustableLimiter } = await getLLM();
    const limiter = createAdjustableLimiter(2);
    const controller = new AbortController();
    controller.abort();
    const fn = vi.fn(async () => 'result');

    await expect(limiter.run(fn, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('rejects a queued task the moment its signal aborts, leaving slot accounting intact', async () => {
    const { createAdjustableLimiter } = await getLLM();
    const limiter = createAdjustableLimiter(1);
    let releaseA;
    // Occupy the only slot with a running, signal-less task.
    const taskA = limiter.run(
      () =>
        new Promise((resolve) => {
          releaseA = () => resolve('A result');
        }),
    );

    const controllerB = new AbortController();
    const fnB = vi.fn(async () => 'B result');
    // Queued behind the full limiter — never gets a slot before it aborts.
    const taskB = limiter.run(fnB, controllerB.signal);

    controllerB.abort();
    await expect(taskB).rejects.toMatchObject({ name: 'AbortError' });
    expect(fnB).not.toHaveBeenCalled();

    // A later-queued task still runs once the slot frees, proving `active`
    // was never touched by the queued cancellation above.
    const fnC = vi.fn(async () => 'C result');
    const taskC = limiter.run(fnC);

    releaseA();
    await expect(taskA).resolves.toBe('A result');
    await expect(taskC).resolves.toBe('C result');
    expect(fnC).toHaveBeenCalledTimes(1);
  });

  it('runs a queued task normally when slot frees and cleans up its abort listener', async () => {
    const { createAdjustableLimiter } = await getLLM();
    const limiter = createAdjustableLimiter(1);
    let releaseA;
    const taskA = limiter.run(() => new Promise((r) => (releaseA = r)));

    const controllerB = new AbortController();
    const fnB = vi.fn(async () => 'B result');
    const taskB = limiter.run(fnB, controllerB.signal);

    // Let the event loop / microtask queue run to initialize releaseA
    await new Promise((resolve) => setTimeout(resolve, 0));

    releaseA();
    await expect(taskA).resolves.toBeUndefined();
    await expect(taskB).resolves.toBe('B result');
    expect(fnB).toHaveBeenCalledTimes(1);
  });
});

describe('mergeAbortSignals', () => {
  it('handles 0 signals', async () => {
    const { mergeAbortSignals } = await getLLM();
    const merged = mergeAbortSignals();
    expect(merged.signal).toBeUndefined();
    expect(typeof merged.dispose).toBe('function');
    merged.dispose();
  });

  it('handles 1 signal', async () => {
    const { mergeAbortSignals } = await getLLM();
    const controller = new AbortController();
    const merged = mergeAbortSignals(controller.signal);
    expect(merged.signal).toBe(controller.signal);
    expect(typeof merged.dispose).toBe('function');
    merged.dispose();
  });

  it('handles multiple signals (with AbortSignal.any supported)', async () => {
    const { mergeAbortSignals } = await getLLM();
    const controller1 = new AbortController();
    const controller2 = new AbortController();
    const merged = mergeAbortSignals(controller1.signal, controller2.signal);
    expect(merged.signal.aborted).toBe(false);
    controller1.abort();
    expect(merged.signal.aborted).toBe(true);
    merged.dispose();
  });

  it('handles multiple signals (fallback logic when AbortSignal.any is absent)', async () => {
    const { mergeAbortSignals } = await getLLM();
    const originalAny = AbortSignal.any;
    Object.defineProperty(AbortSignal, 'any', {
      value: undefined,
      configurable: true,
    });

    try {
      const controller1 = new AbortController();
      const controller2 = new AbortController();
      const merged = mergeAbortSignals(controller1.signal, controller2.signal);
      expect(merged.signal.aborted).toBe(false);
      controller2.abort();
      expect(merged.signal.aborted).toBe(true);
      merged.dispose();

      // Test pre-aborted signal path in fallback logic
      const preAborted = new AbortController();
      preAborted.abort();
      const controller3 = new AbortController();
      const merged2 = mergeAbortSignals(preAborted.signal, controller3.signal);
      expect(merged2.signal.aborted).toBe(true);
      merged2.dispose();
    } finally {
      Object.defineProperty(AbortSignal, 'any', {
        value: originalAny,
        configurable: true,
      });
    }
  });
});

describe('createRequestTimeoutSignal', () => {
  it('creates a timeout signal and fires abort after ms', async () => {
    const { createRequestTimeoutSignal } = await getLLM();
    vi.useFakeTimers();
    const timeout = createRequestTimeoutSignal(1000);
    expect(timeout.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(timeout.signal.aborted).toBe(true);
    expect(timeout.signal.reason?.name).toBe('TimeoutError');
    vi.useRealTimers();
  });

  it('does not fire abort if disposed before timeout', async () => {
    const { createRequestTimeoutSignal } = await getLLM();
    vi.useFakeTimers();
    const timeout = createRequestTimeoutSignal(1000);
    timeout.dispose();
    vi.advanceTimersByTime(1000);
    expect(timeout.signal.aborted).toBe(false);
    vi.useRealTimers();
  });
});

describe('sleepWithAbort', () => {
  it('resolves after ms when no signal is present', async () => {
    const { sleepWithAbort } = await getLLM();
    vi.useFakeTimers();
    const promise = sleepWithAbort(500);
    vi.advanceTimersByTime(500);
    await expect(promise).resolves.toBeUndefined();
    vi.useRealTimers();
  });

  it('rejects immediately if signal is already aborted', async () => {
    const { sleepWithAbort } = await getLLM();
    const controller = new AbortController();
    controller.abort();
    await expect(sleepWithAbort(500, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('rejects if signal aborts during sleep', async () => {
    const { sleepWithAbort } = await getLLM();
    vi.useFakeTimers();
    const controller = new AbortController();
    const promise = sleepWithAbort(1000, controller.signal);
    vi.advanceTimersByTime(500);
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    vi.useRealTimers();
  });
});
