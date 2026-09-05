// LLM client entrypoint for the PageToLLM Canvas pipeline.
// Runs in the service worker context; dispatches to the active provider's client.

import { getActiveProvider } from './providers.js';
import { resolveProviderTemperature } from './temperatures.js';
import { createClient } from './clients.js';
import { getStoredVerboseLogs } from '../../src/shared/runtime/verboseLogSettings.js';
import { getStoredLlmRequestTimeoutSeconds } from '../settings/llmTimeout.js';
import { createLogger } from '../../src/shared/runtime/log.js';
import {
  createRequestTimeoutSignal,
  defaultScheduler,
  isAbortRejection,
  makeAbortError,
  mergeAbortSignals,
  sleepWithAbort,
} from './abortSignals.js';

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
 * @param {string} [options.taskType] Telemetry task type; selects the provider temperature.
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
  const { prompt = '', messages, tools, toolChoice, parallelToolCalls, signal } = options;
  // Snapshot settings per call (independent of provider resolution below, so
  // overlap them instead of chaining after it) so mid-flight options changes
  // apply only to the next request or retry attempt. This extra handler keeps
  // an early return below from surfacing an unhandled rejection; it doesn't
  // suppress the failure, since the later `await settingsPromise` still
  // throws normally on the paths that reach it.
  const settingsPromise = Promise.all([getRequestTimeoutSeconds(), getVerboseLogs()]);
  settingsPromise.catch((e) => logWarn('settings read failed:', getErrorMessage(e)));
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

  // Provider-configured, per-task temperature. Undefined leaves the parameter
  // out of the request entirely — the only shape some models accept.
  const temperature = resolveProviderTemperature(provider, options.taskType);

  let client;
  try {
    client = clientFactory(provider, { transport, logger: clientLogger });
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e), retryable: false };
  }

  const startedAt = clock();
  const [requestTimeoutSeconds, verboseLogs] = await settingsPromise;
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

/**
 * @param {Function} callDirect Direct LLM request function.
 * @param {object} options
 * @param {string} options.prompt
 * @param {string} [options.taskType]
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
 * @param {string} [opts.taskType]
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

const defaultLLMService = createLLMService();

/**
 * Makes one completion request using the configured provider.
 * @param {object} options Request options.
 * @param {string} [options.prompt] Prompt text.
 * @param {Array<Record<string, unknown>>} [options.messages] Message history.
 * @param {Array<Record<string, unknown>>} [options.tools] Tool definitions.
 * @param {unknown} [options.toolChoice] Provider tool-choice policy.
 * @param {boolean} [options.parallelToolCalls] Whether parallel tool calls are allowed.
 * @param {string} [options.taskType] Telemetry task type; picks the provider-configured temperature.
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
