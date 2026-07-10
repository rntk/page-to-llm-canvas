// LLM client entrypoint for the PageToLLM Canvas pipeline.
// Runs in the service worker context; dispatches to the active provider's client.

export const LLM_REQUEST_TIMEOUT_MS = 120_000;
import { getActiveProvider } from './providers.js';
import { createClient } from './llm_clients.js';
import { getStoredVerboseLogs } from './verboseLogSettings.js';

/**
 * Makes a single completion call to the active provider.
 * Returns `{ok, content?, error?}` — the same shape used by the background
 * message handler so it can delegate here too.
 *
 * The `model` argument is accepted for backwards-compatibility but ignored; the
 * model is taken from the active provider configured on the options page.
 *
 * Request/response console detail (and the raw client dumps inside
 * llm_clients.js) only fire when the "verbose pipeline logs" setting is on.
 * Failures still always warn.
 *
 * @param {{
 *   prompt: string,
 *   temperature?: number,
 *   model?: string,
 *   signal?: AbortSignal,
 *   metricsCollector?: (sample: Record<string, unknown>) => void,
 * }} options
 * @returns {Promise<{ok: boolean, content?: string, error?: string}>}
 */
export async function callLLMDirect(options) {
  const { prompt, temperature = 0.8, signal } = options;
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
  const timeoutSignal = createRequestTimeoutSignal(LLM_REQUEST_TIMEOUT_MS);
  const requestSignal = mergeAbortSignals(signal, timeoutSignal.signal);
  // Snapshot per call so a mid-flight options toggle cannot half-apply.
  const verboseLogs = await getStoredVerboseLogs();
  if (verboseLogs) {
    console.info('PageToLLM Canvas LLM request:', {
      provider: provider.name,
      type: provider.type,
      model: provider.model,
      promptLength: prompt.length,
      temperature,
    });
  }

  try {
    const {
      content,
      endpoint,
      model,
      provider: clientProvider,
      usage,
    } = await client.complete({
      prompt,
      temperature,
      signal: requestSignal,
      verboseLogs,
    });
    try {
      options.metricsCollector?.({
        provider: clientProvider || provider.type,
        model: model || provider.model,
        requestChars: prompt.length,
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
      });
    }
    return { ok: true, content };
  } catch (e) {
    if (signal?.aborted) {
      throw makeAbortError('LLM request aborted');
    }
    const message =
      e && (e.name === 'AbortError' || e.name === 'TimeoutError')
        ? `LLM request timed out after ${LLM_REQUEST_TIMEOUT_MS}ms`
        : (e && e.message) || String(e);
    console.warn('PageToLLM Canvas LLM request failed:', message);
    return { ok: false, error: message };
  } finally {
    timeoutSignal.dispose();
  }
}

function makeAbortError(message) {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function mergeAbortSignals(...signals) {
  const activeSignals = signals.filter(Boolean);
  if (activeSignals.length === 0) return undefined;
  if (activeSignals.length === 1) return activeSignals[0];
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
    return AbortSignal.any(activeSignals);
  }

  const controller = new AbortController();
  const abort = () => controller.abort();
  for (const signal of activeSignals) {
    if (signal.aborted) {
      abort();
      break;
    }
    signal.addEventListener('abort', abort, { once: true });
  }
  return controller.signal;
}

function createRequestTimeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return {
      signal: AbortSignal.timeout(ms),
      dispose() {},
    };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timeoutId);
    },
  };
}

/**
 * @param {{prompt: string, temperature?: number, model?: string, signal?: AbortSignal, metricsCollector?: (sample: Record<string, unknown>) => void}} options
 * @returns {Promise<string>}
 */
export async function callLLM(options) {
  const response = await callLLMDirect(options);
  if (!response.ok || typeof response.content !== 'string') {
    const message = response.error || 'LLM request failed';
    throw new Error(message);
  }
  return response.content;
}

/**
 * @param {{prompt: string, temperature?: number, model?: string, signal?: AbortSignal, metricsCollector?: (sample: Record<string, unknown>) => void}} opts
 * @param {number} [maxRetries]
 * @returns {Promise<string>}
 */
export async function callLLMWithRetry(opts, maxRetries = 3) {
  let lastErr;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (opts.signal?.aborted) {
      throw makeAbortError('LLM request aborted');
    }
    try {
      return await callLLM(opts);
    } catch (e) {
      lastErr = e;
      if (opts.signal?.aborted || e?.name === 'AbortError') break;
      console.warn('PageToLLM Canvas LLM attempt failed:', {
        attempt: attempt + 1,
        maxRetries,
        error: (e && e.message) || String(e),
      });
      if (attempt === maxRetries - 1) break;
      const delay = 1000 * Math.pow(2, attempt);
      await sleepWithAbort(delay, opts.signal);
    }
  }
  throw lastErr;
}

function sleepWithAbort(ms, signal) {
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
  let active = 0;
  const queue = [];
  function tryNext() {
    if (active >= limit) return;
    const next = queue.shift();
    if (!next) return;
    active++;
    next();
  }
  return function run(fn) {
    return new Promise((resolve, reject) => {
      queue.push(() => {
        Promise.resolve()
          .then(fn)
          .then(resolve, reject)
          .finally(() => {
            active--;
            tryNext();
          });
      });
      tryNext();
    });
  };
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
  const workers = new Array(Math.min(limit, remaining)).fill(0).map(async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
