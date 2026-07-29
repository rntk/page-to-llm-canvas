// LLM client entrypoint for the PageToLLM Canvas pipeline.
// Runs in the service worker context; dispatches to the active provider's client.

import { getActiveProvider } from './providers.js';
import { createClient } from './clients.js';
import { getStoredVerboseLogs } from '../settings/verboseLog.js';
import { getStoredLlmRequestTimeoutSeconds } from '../settings/llmTimeout.js';

/**
 * Makes a single completion call to the active provider.
 * Returns `{ok, content?, error?}` — the same shape used by the background
 * message handler so it can delegate here too.
 *
 * Request/response console detail (and the raw client dumps inside
 * clients.js) only fire when the "verbose pipeline logs" setting is on.
 * Failures still always warn.
 *
 * @param {{
 *   prompt?: string,
 *   messages?: Array<Record<string, unknown>>,
 *   tools?: Array<Record<string, unknown>>,
 *   toolChoice?: unknown,
 *   parallelToolCalls?: boolean,
 *   temperature?: number,
 *   signal?: AbortSignal,
 *   metricsCollector?: (sample: Record<string, unknown>) => void,
 * }} options
 * @returns {Promise<{ok: boolean, content?: string, reasoning?: string, toolCalls?: Array<Record<string, unknown>>, error?: string}>}
 */
export async function callLLMDirect(options) {
  const {
    prompt = '',
    messages,
    tools,
    toolChoice,
    parallelToolCalls,
    temperature = 0.8,
    signal,
  } = options;
  let provider;
  try {
    provider = await getActiveProvider();
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
  if (!provider) {
    return {
      ok: false,
      error: 'No LLM provider configured. Add one in the extension options page.',
    };
  }

  let client;
  try {
    client = createClient(provider);
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }

  const startedAt = Date.now();
  // Snapshot settings per call so mid-flight options changes apply only to the
  // next request or retry attempt.
  const [requestTimeoutSeconds, verboseLogs] = await Promise.all([
    getStoredLlmRequestTimeoutSeconds(),
    getStoredVerboseLogs(),
  ]);
  const requestTimeoutMs = requestTimeoutSeconds * 1000;
  const timeoutSignal = createRequestTimeoutSignal(requestTimeoutMs);
  const mergedSignal = mergeAbortSignals(signal, timeoutSignal.signal);
  if (verboseLogs) {
    console.info('PageToLLM Canvas LLM request:', {
      provider: provider.name,
      type: provider.type,
      model: provider.model,
      promptLength: prompt.length,
      messageCount: Array.isArray(messages) ? messages.length : undefined,
      toolCount: Array.isArray(tools) ? tools.length : undefined,
      temperature,
      timeoutMs: requestTimeoutMs,
    });
  }

  try {
    const {
      content,
      endpoint,
      model,
      provider: clientProvider,
      usage,
      reasoning,
      toolCalls,
    } = await client.complete({
      prompt,
      messages,
      tools,
      toolChoice,
      parallelToolCalls,
      temperature,
      signal: mergedSignal.signal,
      verboseLogs,
    });
    try {
      options.metricsCollector?.({
        provider: clientProvider || provider.type,
        model: model || provider.model,
        requestChars:
          prompt.length +
          (Array.isArray(messages)
            ? messages.reduce(
                (total, message) =>
                  total + (typeof message?.content === 'string' ? message.content.length : 0),
                0,
              )
            : 0),
        responseChars: content.length,
        usage,
      });
    } catch (_) {
      // Diagnostics must never turn a successful model response into a failure.
    }
    if (verboseLogs) {
      console.info('PageToLLM Canvas LLM response:', {
        endpoint,
        durationMs: Date.now() - startedAt,
        responseLength: content.length,
        toolCallCount: toolCalls?.length || 0,
      });
    }
    return {
      ok: true,
      content,
      ...(reasoning ? { reasoning } : {}),
      ...(toolCalls?.length ? { toolCalls } : {}),
    };
  } catch (e) {
    if (signal?.aborted) {
      throw makeAbortError('LLM request aborted');
    }
    const message =
      e && (e.name === 'AbortError' || e.name === 'TimeoutError')
        ? `LLM request timed out after ${requestTimeoutMs}ms`
        : (e && e.message) || String(e);
    console.warn('PageToLLM Canvas LLM request failed:', message);
    return {
      ok: false,
      error: message,
      ...(Number.isFinite(e?.status) ? { status: e.status } : {}),
      ...(Number.isFinite(e?.retryAfterMs) ? { retryAfterMs: e.retryAfterMs } : {}),
    };
  } finally {
    timeoutSignal.dispose();
    mergedSignal.dispose();
  }
}

function makeAbortError(message) {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

export function mergeAbortSignals(...signals) {
  const activeSignals = signals.filter(Boolean);
  if (activeSignals.length === 0) return { signal: undefined, dispose() {} };
  if (activeSignals.length === 1) return { signal: activeSignals[0], dispose() {} };
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
    return { signal: AbortSignal.any(activeSignals), dispose() {} };
  }

  const controller = new AbortController();
  const abort = () => controller.abort();
  const listenedSignals = [];
  for (const signal of activeSignals) {
    if (signal.aborted) {
      abort();
      break;
    }
    signal.addEventListener('abort', abort, { once: true });
    listenedSignals.push(signal);
  }
  return {
    signal: controller.signal,
    dispose() {
      for (const signal of listenedSignals) {
        signal.removeEventListener('abort', abort);
      }
    },
  };
}

export function createRequestTimeoutSignal(ms) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(
      typeof DOMException !== 'undefined'
        ? new DOMException('Timeout', 'TimeoutError')
        : Object.assign(new Error('Timeout'), { name: 'TimeoutError' }),
    );
  }, ms);
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timeoutId);
    },
  };
}

/**
 * @param {{prompt: string, temperature?: number, signal?: AbortSignal, metricsCollector?: (sample: Record<string, unknown>) => void}} options
 * @returns {Promise<string>}
 */
export async function callLLM(options) {
  const response = await callLLMDirect(options);
  if (!response.ok || typeof response.content !== 'string') {
    const message = response.error || 'LLM request failed';
    const error = new Error(message);
    if (Number.isFinite(response.status)) error.status = response.status;
    if (Number.isFinite(response.retryAfterMs)) error.retryAfterMs = response.retryAfterMs;
    throw error;
  }
  return response.content;
}

/**
 * @param {{prompt: string, temperature?: number, signal?: AbortSignal, metricsCollector?: (sample: Record<string, unknown>) => void}} opts
 * @param {number} [maxRetries]
 * @returns {Promise<string>}
 */
export async function callLLMWithRetry(opts, maxRetries = 3) {
  // Guard against a caller-supplied maxRetries <= 0/NaN reaching the final
  // `throw lastErr` with lastErr still undefined — always make at least one attempt.
  const attempts = Number.isFinite(maxRetries) && maxRetries >= 1 ? Math.trunc(maxRetries) : 1;
  let lastErr;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (opts.signal?.aborted) {
      throw makeAbortError('LLM request aborted');
    }
    try {
      return await callLLM(opts);
    } catch (e) {
      lastErr = e;
      if (opts.signal?.aborted || e?.name === 'AbortError') break;
      // A 4xx status other than 408 (timeout) or 429 (rate limit) reflects a
      // malformed/unauthorized request that will never succeed on retry.
      // Statusless errors (network failures, timeouts) and 408/429/5xx remain retryable.
      if (
        Number.isFinite(e?.status) &&
        e.status >= 400 &&
        e.status < 500 &&
        e.status !== 408 &&
        e.status !== 429
      ) {
        break;
      }
      console.warn('PageToLLM Canvas LLM attempt failed:', {
        attempt: attempt + 1,
        maxRetries: attempts,
        error: (e && e.message) || String(e),
      });
      if (attempt === attempts - 1) break;
      // Equal-jitter backoff spreads retries so multiple concurrent requests
      // that failed together do not all retry in lockstep.
      let delay = 1000 * Math.pow(2, attempt) * (0.5 + Math.random());
      if (Number.isFinite(e?.retryAfterMs) && e.retryAfterMs > 0) {
        // Honor the provider's Retry-After when present, capped at 60s.
        delay = Math.min(Math.max(e.retryAfterMs, delay), 60_000);
      }
      await sleepWithAbort(delay, opts.signal);
    }
  }
  throw lastErr;
}

export function sleepWithAbort(ms, signal) {
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  if (signal.aborted) {
    return Promise.reject(makeAbortError('LLM request aborted'));
  }
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timeoutId);
      reject(makeAbortError('LLM request aborted'));
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Returns a function that runs async tasks with at most `limit` in flight.
 * Tasks beyond the limit queue in FIFO order. Unlike parallelMap this gates
 * individually submitted tasks, so it suits recursive traversals where the
 * full task list is not known up front.
 *
 * @param {number} limit
 * @returns {<T>(fn: () => Promise<T>) => Promise<T>}
 */
export function createLimiter(limit) {
  const normalizedLimit = normalizeLimiterLimit(limit);
  let active = 0;
  const queue = [];

  function tryNext() {
    if (active >= normalizedLimit) return;
    const next = queue.shift();
    if (!next) return;
    active++;
    next();
  }

  return function run(fn) {
    return new Promise((resolve, reject) => {
      queue.push(() => {
        // Release the slot before exposing the task's outcome to its caller.
        // Apart from making the limiter's state consistent at settlement time,
        // handling cleanup in the same promise path prevents a throw from
        // tryNext() becoming an ignored rejection from a detached finally().
        const settleAfterCleanup = (settle, value) => {
          try {
            active--;
            tryNext();
          } catch (error) {
            reject(error);
            return;
          }
          settle(value);
        };

        Promise.resolve().then(fn).then(
          (value) => settleAfterCleanup(resolve, value),
          (error) => settleAfterCleanup(reject, error),
        );
      });
      tryNext();
    });
  };
}

/**
 * Returns a FIFO concurrency limiter whose cap can be changed without replacing
 * the queue. When the cap is lowered below the current active count, active
 * tasks finish normally and no queued task starts until the new cap allows it.
 *
 * @param {number} initialLimit
 * @returns {{run: <T>(fn: () => Promise<T>, signal?: AbortSignal) => Promise<T>, setLimit: (limit: number) => void}}
 */
export function createAdjustableLimiter(initialLimit) {
  let limit = normalizeLimiterLimit(initialLimit);
  let active = 0;
  const queue = [];

  function drain() {
    while (active < limit && queue.length > 0) {
      const next = queue.shift();
      // The entry has started now; its abort listener (if any) no longer
      // needs to watch the queue — the running fn handles its own abort.
      if (next.signal) next.signal.removeEventListener('abort', next.onAbort);
      active++;
      Promise.resolve()
        .then(next.fn)
        .then(next.resolve, next.reject)
        .finally(() => {
          active--;
          drain();
        });
    }
  }

  return {
    run(fn, signal) {
      if (signal?.aborted) {
        return Promise.reject(makeAbortError('LLM request aborted'));
      }
      return new Promise((resolve, reject) => {
        const entry = { fn, resolve, reject, signal };
        if (signal) {
          entry.onAbort = () => {
            const index = queue.indexOf(entry);
            // Already dequeued (started running): let the running fn's own
            // abort handling take care of it — the slot accounting here must
            // stay untouched since a queued entry never incremented `active`.
            if (index === -1) return;
            queue.splice(index, 1);
            reject(makeAbortError('LLM request aborted'));
          };
          signal.addEventListener('abort', entry.onAbort, { once: true });
        }
        queue.push(entry);
        drain();
      });
    },
    setLimit(nextLimit) {
      limit = normalizeLimiterLimit(nextLimit);
      drain();
    },
  };
}

function normalizeLimiterLimit(value) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

/**
 * @template T,U
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<U>} fn
 * @param {{warmupFirst?: boolean}} [options] When `warmupFirst` is set, the first
 *   item runs to completion before the concurrent burst is released. Every
 *   request in a burst shares the same long prompt prefix, so completing one
 *   first lets the provider commit that prefix to its prompt/KV cache and the
 *   rest reuse it instead of each re-prefilling it from cold. Skipped when there
 *   is fewer than one item to follow, so at least one item always remains for
 *   the parallel phase. A throwing `fn` rejects before the burst starts, just as
 *   it would inside the burst.
 *
 *   Once any worker's `fn` rejects, no worker claims a NEW item afterward —
 *   in-flight items are left to finish, but the failure stops the burst from
 *   growing. The returned promise rejects with that first error as soon as it
 *   occurs.
 * @returns {Promise<U[]>}
 */
export async function parallelMap(items, limit, fn, { warmupFirst = false } = {}) {
  const results = new Array(items.length);
  let next = 0;
  if (warmupFirst && items.length > 1) {
    results[next] = await fn(items[next], next);
    next++;
  }
  const remaining = Math.max(items.length - next, 1);
  let failed = false;
  const workers = new Array(Math.min(limit, remaining)).fill(0).map(async () => {
    while (true) {
      if (failed) return;
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
      } catch (e) {
        failed = true;
        throw e;
      }
    }
  });
  await Promise.all(workers);
  return results;
}
