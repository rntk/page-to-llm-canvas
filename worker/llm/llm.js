// LLM client entrypoint for the PageToLLM Canvas pipeline.
// Runs in the service worker context; dispatches to the active provider's client.

import { getActiveProvider } from './providers.js';
import { createClient } from './clients.js';
import { getStoredVerboseLogs } from '../settings/verboseLog.js';
import { getStoredLlmRequestTimeoutSeconds } from '../settings/llmTimeout.js';
import { createLogger } from '../../src/shared/runtime/log.js';

const log = createLogger('LLM');

/**
 * @typedef {Object} LLMDirectResult
 * @property {boolean} ok Whether the request succeeded.
 * @property {string} [content] Completion content.
 * @property {string} [reasoning] Provider reasoning text.
 * @property {Array<Record<string, unknown>>} [toolCalls] Normalized tool calls.
 * @property {string} [error] Failure message.
 * @property {boolean} [retryable] Whether retrying can succeed.
 * @property {number} [status] HTTP status when available.
 * @property {number} [retryAfterMs] Provider retry delay when available.
 */

const defaultScheduler = Object.freeze({
  setTimeout: (...args) => globalThis.setTimeout(...args),
  clearTimeout: (timeoutId) => globalThis.clearTimeout(timeoutId),
});

const defaultLLMDependencies = Object.freeze({
  getActiveProvider,
  clientFactory: createClient,
  getRequestTimeoutSeconds: getStoredLlmRequestTimeoutSeconds,
  getVerboseLogs: getStoredVerboseLogs,
  transport: (...args) => globalThis.fetch(...args),
  setTimeout: defaultScheduler.setTimeout,
  clearTimeout: defaultScheduler.clearTimeout,
  clock: Date.now,
  random: Math.random,
  logInfo: log.info,
  logWarn: log.warn,
});

/**
 * Creates an LLM boundary with all external capabilities supplied explicitly.
 * Production exports below use the default service; focused tests and other
 * runtimes can construct an isolated service without module mocking.
 * Dependencies follow the repository's flat service-factory convention: each
 * key replaces one function, so partial nested capability objects cannot drop
 * required sibling methods.
 * @param {object} [overrides] External LLM capabilities to replace.
 * @param {Function} [overrides.getActiveProvider] Active-provider lookup.
 * @param {Function} [overrides.clientFactory] Provider client factory.
 * @param {Function} [overrides.getRequestTimeoutSeconds] Timeout setting reader.
 * @param {Function} [overrides.getVerboseLogs] Verbose-log setting reader.
 * @param {Function} [overrides.transport] HTTP transport.
 * @param {Function} [overrides.setTimeout] Timeout scheduler.
 * @param {Function} [overrides.clearTimeout] Timeout canceller.
 * @param {function(): number} [overrides.clock] Current time in milliseconds.
 * @param {function(): number} [overrides.random] Random value source.
 * @param {Function} [overrides.logInfo] Informational logger.
 * @param {Function} [overrides.logWarn] Warning logger.
 */
export function createLLMService(overrides = {}) {
  const dependencies = { ...defaultLLMDependencies, ...overrides };
  const callDirect = (options) => callLLMDirectWithDependencies(options, dependencies);
  const call = (options) => callLLMUsing(callDirect, options);
  const callWithRetry = (options, maxRetries) =>
    callLLMWithRetryUsing(call, dependencies, options, maxRetries);
  return Object.freeze({
    callLLMDirect: callDirect,
    callLLM: call,
    callLLMWithRetry: callWithRetry,
  });
}

/**
 * Makes a single completion call to the active provider.
 * Returns `{ok, content?, error?}` — the same shape used by the background
 * message handler so it can delegate here too.
 *
 * Request/response console detail (and the raw client dumps inside
 * clients.js) only fire when the "verbose pipeline logs" setting is on.
 * Failures still always warn.
 *
 * @param {object} options
 * @param {string} [options.prompt]
 * @param {Array<Record<string, unknown>>} [options.messages]
 * @param {Array<Record<string, unknown>>} [options.tools]
 * @param {unknown} [options.toolChoice]
 * @param {boolean} [options.parallelToolCalls]
 * @param {number} [options.temperature]
 * @param {AbortSignal} [options.signal]
 * @param {object|null} [options.provider] Provider snapshot to use instead of rereading the active provider.
 * @param {function(Record<string, unknown>): void} [options.metricsCollector]
 * @param {object} dependencies External LLM capabilities.
 * @returns {Promise<LLMDirectResult>} Completion result.
 */
async function callLLMDirectWithDependencies(options, dependencies) {
  const {
    getActiveProvider: readActiveProvider,
    clientFactory,
    getRequestTimeoutSeconds,
    getVerboseLogs,
    transport,
    setTimeout: scheduleTimeout,
    clearTimeout: cancelTimeout,
    clock,
    logInfo,
    logWarn,
  } = dependencies;
  const scheduler = { setTimeout: scheduleTimeout, clearTimeout: cancelTimeout };
  const clientLogger = { info: logInfo, warn: logWarn };
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
  if (options.provider !== undefined) {
    provider = options.provider;
  } else {
    try {
      provider = await readActiveProvider();
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e), retryable: false };
    }
  }
  if (!provider) {
    return {
      ok: false,
      error: 'No LLM provider configured. Add one in the extension options page.',
      retryable: false,
    };
  }

  let client;
  try {
    client = clientFactory(provider, { transport, logger: clientLogger });
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e), retryable: false };
  }

  const startedAt = clock();
  // Snapshot settings per call so mid-flight options changes apply only to the
  // next request or retry attempt.
  const [requestTimeoutSeconds, verboseLogs] = await Promise.all([
    getRequestTimeoutSeconds(),
    getVerboseLogs(),
  ]);
  const requestTimeoutMs = requestTimeoutSeconds * 1000;
  const timeoutSignal = createRequestTimeoutSignal(requestTimeoutMs, scheduler);
  const mergedSignal = mergeAbortSignals(signal, timeoutSignal.signal);
  if (verboseLogs) {
    logInfo('request:', {
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
      logInfo('response:', {
        endpoint,
        durationMs: clock() - startedAt,
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
    // A provider/transport error can settle after the caller aborts. Treat it
    // as cancellation only when the rejection itself is abort-shaped (or is
    // the signal's exact abort reason); the signal state alone would discard a
    // genuine provider failure that won the response race.
    if (isAbortRejection(e, signal)) {
      throw makeAbortError('LLM request aborted');
    }
    const message =
      e && (e.name === 'AbortError' || e.name === 'TimeoutError')
        ? `LLM request timed out after ${requestTimeoutMs}ms`
        : getErrorMessage(e);
    logWarn('request failed:', message);
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

function getErrorMessage(error) {
  if (typeof error?.message === 'string' && error.message) return error.message;
  if (typeof error?.error === 'string' && error.error) return error.error;
  if (typeof error === 'string') return error;
  try {
    const serialized = JSON.stringify(error);
    if (serialized && serialized !== '{}') return serialized;
  } catch (_) {
    // Fall through to String for circular provider error objects.
  }
  return String(error);
}

function makeAbortError(message) {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function isAbortRejection(error, signal) {
  if (!signal?.aborted) return false;
  const reason = signal.reason;
  const seen = new Set();
  let current = error;
  while (current && (typeof current === 'object' || typeof current === 'function')) {
    if (seen.has(current)) break;
    seen.add(current);
    if (current.name === 'AbortError' || current.code === 'ABORT_ERR') return true;
    if (reason !== undefined && current === reason) return true;
    current = current.cause;
  }
  return false;
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

export function createRequestTimeoutSignal(ms, scheduler = defaultScheduler) {
  const controller = new AbortController();
  const timeoutId = scheduler.setTimeout(() => {
    controller.abort(
      typeof DOMException !== 'undefined'
        ? new DOMException('Timeout', 'TimeoutError')
        : Object.assign(new Error('Timeout'), { name: 'TimeoutError' }),
    );
  }, ms);
  return {
    signal: controller.signal,
    dispose() {
      scheduler.clearTimeout(timeoutId);
    },
  };
}

/**
 * @param {Function} callDirect Direct LLM request function.
 * @param {object} options
 * @param {string} options.prompt
 * @param {number} [options.temperature]
 * @param {AbortSignal} [options.signal]
 * @param {function(Record<string, unknown>): void} [options.metricsCollector]
 * @returns {Promise<string>}
 */
async function callLLMUsing(callDirect, options) {
  const response = await callDirect(options);
  if (!response.ok || typeof response.content !== 'string') {
    const message = response.error || 'LLM request failed';
    const error = new Error(message);
    if (Number.isFinite(response.status)) error.status = response.status;
    if (Number.isFinite(response.retryAfterMs)) error.retryAfterMs = response.retryAfterMs;
    if (response.retryable === false) error.retryable = false;
    throw error;
  }
  return response.content;
}

/**
 * @param {Function} call LLM request function.
 * @param {object} dependencies External LLM capabilities.
 * @param {object} opts
 * @param {string} opts.prompt
 * @param {number} [opts.temperature]
 * @param {AbortSignal} [opts.signal]
 * @param {function(Record<string, unknown>): void} [opts.metricsCollector]
 * @param {number} [maxRetries]
 * @returns {Promise<string>}
 */
async function callLLMWithRetryUsing(call, dependencies, opts, maxRetries = 3) {
  const {
    random,
    logWarn,
    setTimeout: scheduleTimeout,
    clearTimeout: cancelTimeout,
  } = dependencies;
  const scheduler = { setTimeout: scheduleTimeout, clearTimeout: cancelTimeout };
  // Guard against a caller-supplied maxRetries <= 0/NaN reaching the final
  // `throw lastErr` with lastErr still undefined — always make at least one attempt.
  const attempts = Number.isFinite(maxRetries) && maxRetries >= 1 ? Math.trunc(maxRetries) : 1;
  let lastErr;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (opts.signal?.aborted) {
      throw makeAbortError('LLM request aborted');
    }
    try {
      return await call(opts);
    } catch (e) {
      lastErr = e;
      if (opts.signal?.aborted || e?.name === 'AbortError') break;
      if (e?.retryable === false) break;
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
      logWarn('attempt failed:', {
        attempt: attempt + 1,
        maxRetries: attempts,
        error: (e && e.message) || String(e),
      });
      if (attempt === attempts - 1) break;
      // Equal-jitter backoff spreads retries so multiple concurrent requests
      // that failed together do not all retry in lockstep.
      let delay = 1000 * Math.pow(2, attempt) * (0.5 + random());
      if (Number.isFinite(e?.retryAfterMs) && e.retryAfterMs > 0) {
        // Honor the provider's Retry-After when present, capped at 60s.
        delay = Math.min(Math.max(e.retryAfterMs, delay), 60_000);
      }
      await sleepWithAbort(delay, opts.signal, scheduler);
    }
  }
  throw lastErr;
}

export function sleepWithAbort(ms, signal, scheduler = defaultScheduler) {
  if (!signal) {
    return new Promise((resolve) => {
      scheduler.setTimeout(resolve, ms);
    });
  }
  if (signal.aborted) {
    return Promise.reject(makeAbortError('LLM request aborted'));
  }
  return new Promise((resolve, reject) => {
    const timeoutId = scheduler.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      scheduler.clearTimeout(timeoutId);
      reject(makeAbortError('LLM request aborted'));
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

const defaultLLMService = createLLMService();

/**
 * Makes one completion request using the configured provider.
 * @param {object} options Request options.
 * @param {string} [options.prompt] Prompt text.
 * @param {Array<Record<string, unknown>>} [options.messages] Message history.
 * @param {Array<Record<string, unknown>>} [options.tools] Tool definitions.
 * @param {unknown} [options.toolChoice] Provider tool-choice policy.
 * @param {boolean} [options.parallelToolCalls] Whether parallel tool calls are allowed.
 * @param {number} [options.temperature] Sampling temperature.
 * @param {AbortSignal} [options.signal] Caller cancellation signal.
 * @param {object|null} [options.provider] Provider snapshot override.
 * @param {function(Record<string, unknown>): void} [options.metricsCollector] Metrics sink.
 * @returns {Promise<LLMDirectResult>} Completion result.
 */
export function callLLMDirect(options) {
  return defaultLLMService.callLLMDirect(options);
}

/**
 * Makes one completion request and throws when it fails.
 * @param {object} options Request options accepted by callLLMDirect.
 * @returns {Promise<string>} Completion content.
 */
export function callLLM(options) {
  return defaultLLMService.callLLM(options);
}

/**
 * Makes a completion request with provider-aware retry behavior.
 * @param {object} options Request options accepted by callLLMDirect.
 * @param {number} [maxRetries] Maximum provider attempts.
 * @returns {Promise<string>} Completion content.
 */
export function callLLMWithRetry(options, maxRetries = 3) {
  return defaultLLMService.callLLMWithRetry(options, maxRetries);
}

/**
 * Returns a function that runs async tasks with at most `limit` in flight.
 * Tasks beyond the limit queue in FIFO order. Unlike parallelMap this gates
 * individually submitted tasks, so it suits recursive traversals where the
 * full task list is not known up front.
 *
 * @param {number} limit
 * @returns {function(function(): Promise<*>): Promise<*>}
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

        Promise.resolve()
          .then(fn)
          .then(
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
 * @returns {{run: function(function(): Promise<*>, AbortSignal): Promise<*>, setLimit: function(number): void}}
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
 * @param {Array<T>} items
 * @param {number} limit
 * @param {function(T, number): Promise<U>} fn
 * @param {object} [options] When `warmupFirst` is set, the first
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
 *
 *   `stopBurst` covers the callers that record a per-item failure instead of
 *   throwing (so one bad item cannot discard the responses its siblings already
 *   paid for). It is consulted after every settled item, warmup included, and a
 *   truthy answer stops new items from being claimed exactly as a rejection
 *   does — in-flight items are still awaited. This is what keeps a permanent
 *   warmup failure (a 401, an unknown model) from fanning out the whole queue
 *   of doomed requests. The returned promise then RESOLVES, and `results` has
 *   holes where items were never claimed, so callers must treat a missing entry
 *   as "not attempted" rather than as a successful empty result.
 * @param {boolean} [options.warmupFirst]
 * @param {function(U, T, number): boolean} [options.stopBurst]
 * @returns {Promise<Array<U>>}
 */
export async function parallelMap(items, limit, fn, { warmupFirst = false, stopBurst } = {}) {
  const results = new Array(items.length);
  let next = 0;
  let failed = false;
  if (warmupFirst && items.length > 1) {
    results[next] = await fn(items[next], next);
    if (stopBurst && stopBurst(results[next], items[next], next)) return results;
    next++;
  }
  const remaining = Math.max(items.length - next, 1);
  const workers = new Array(Math.min(limit, remaining)).fill(0).map(async () => {
    while (true) {
      if (failed) return;
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
        // Same one-way flag as below, set from a per-item failure the caller
        // recorded rather than threw.
        // eslint-disable-next-line require-atomic-updates
        if (stopBurst && stopBurst(results[i], items[i], i)) failed = true;
      } catch (e) {
        // `failed` is a one-way flag: every write is an unconditional `true`, never
        // derived from a prior read, so concurrent workers racing to set it is harmless.
        // eslint-disable-next-line require-atomic-updates
        failed = true;
        throw e;
      }
    }
  });
  await Promise.all(workers);
  return results;
}
