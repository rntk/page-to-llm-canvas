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

  it('can be isolated through the LLM service capabilities', async () => {
    const { createLLMService } = await getLLM();
    const provider = { type: 'openai', model: 'model-1', name: 'Injected' };
    const transport = vi.fn();
    const complete = vi.fn().mockResolvedValue({
      content: 'result',
      provider: 'openai',
      model: 'model-1',
    });
    const clientFactory = vi.fn(() => ({ complete }));
    const logInfo = vi.fn();
    const logWarn = vi.fn();
    const clearTimeout = vi.fn();
    const service = createLLMService({
      getActiveProvider: vi.fn().mockResolvedValue(provider),
      clientFactory,
      getRequestTimeoutSeconds: vi.fn().mockResolvedValue(12),
      getVerboseLogs: vi.fn().mockResolvedValue(false),
      transport,
      setTimeout: vi.fn(() => 17),
      clearTimeout,
      clock: vi.fn(() => 100),
      random: vi.fn(() => 0),
      logInfo,
      logWarn,
    });

    await expect(service.callLLMDirect({ prompt: 'hello' })).resolves.toEqual({
      ok: true,
      content: 'result',
    });
    expect(clientFactory).toHaveBeenCalledWith(provider, {
      transport,
      logger: { info: logInfo, warn: logWarn },
    });
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'hello' }));
    expect(clearTimeout).toHaveBeenCalledWith(17);
  });

  it('keeps default sibling capabilities when individual dependencies are overridden', async () => {
    const { createLLMService } = await getLLM();
    const service = createLLMService({
      getActiveProvider: vi.fn().mockResolvedValue(OPENAI_COMP_PROVIDER),
      clientFactory: vi.fn(() => ({
        complete: vi.fn().mockRejectedValue(new Error('provider failed')),
      })),
      getVerboseLogs: vi.fn().mockResolvedValue(false),
      setTimeout: vi.fn(() => 17),
      logInfo: vi.fn(),
    });

    await expect(service.callLLMDirect({ prompt: 'hello' })).resolves.toMatchObject({
      ok: false,
      error: 'provider failed',
    });
    expect(console.warn).toHaveBeenCalledWith(
      'PageToLLM Canvas LLM request failed:',
      'provider failed',
    );
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
    expect(res.retryable).toBe(false);
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

  it('uses an explicit provider snapshot instead of rereading the active provider', async () => {
    const { callLLMDirect } = await getLLM();
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'snapshot response' } }] }),
    });
    const provider = {
      ...OPENAI_COMP_PROVIDER,
      id: 'snapshot',
      name: 'Snapshot',
      url: 'http://snapshot.local:9000',
    };

    await expect(callLLMDirect({ prompt: 'hello', provider })).resolves.toEqual({
      ok: true,
      content: 'snapshot response',
    });
    expect(fetch).toHaveBeenCalledWith(
      'http://snapshot.local:9000/v1/chat/completions',
      expect.objectContaining({ method: 'POST' }),
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

  it('preserves a provider failure that settles after the caller signal aborts', async () => {
    const { callLLMDirect } = await getLLM();
    const controller = new AbortController();
    vi.mocked(fetch).mockImplementation(async () => {
      controller.abort();
      throw new Error('provider rejected the request');
    });

    await expect(
      callLLMDirect({ prompt: 'hello', signal: controller.signal }),
    ).resolves.toMatchObject({ ok: false, error: 'provider rejected the request' });
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

  it("uses an object rejection's provider error field", async () => {
    const { callLLMDirect } = await getLLM();
    vi.mocked(fetch).mockRejectedValue({ error: 'Provider is overloaded' });

    const res = await callLLMDirect({ prompt: 'hello' });
    expect(res).toMatchObject({ ok: false, error: 'Provider is overloaded' });
    expect(console.warn).toHaveBeenCalledWith(
      'PageToLLM Canvas LLM request failed:',
      'Provider is overloaded',
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
    const { callLLMDirect } = await getLLM();
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'Success' } }] }),
    });

    await callLLMDirect({ prompt: 'hello' });
    expect(fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(clearSpy).toHaveBeenCalled();
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

  it('does not retry when no provider is configured', async () => {
    stubChrome({ providers: [], activeId: null });
    const { callLLMWithRetry } = await getLLM();

    await expect(callLLMWithRetry({ prompt: 'hello' }, 3)).rejects.toMatchObject({
      message: expect.stringContaining('No LLM provider configured'),
      retryable: false,
    });
    expect(fetch).not.toHaveBeenCalled();
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

