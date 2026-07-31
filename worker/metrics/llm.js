// Isolated LLM request duration, token, and prompt-cache metrics.
//
// TO REMOVE ENTIRELY:
//   1. Delete this file (and llm.test.js)
//   2. In orchestrator.js: remove the llmMetrics import + wrap lines; restore
//      a plain `callLLMWithRetry` import from ../llm/llm.js
//   3. In background.js: remove the recordLlmMetric import + the metrics wiring
//      in the MSG.llmChatCompletion handler (and drop `taskType` from the chat
//      send payloads in src/chat/articleChat.js)
//   4. In OptionsApp.jsx: remove LlmMetricsSection + its import + render

import { LLM_TASK_TYPES } from '../../src/shared/runtime/telemetry.js';

export { LLM_TASK_TYPES } from '../../src/shared/runtime/telemetry.js';

export const LLM_METRICS_KEY = 'pagetollm-llm-metrics';
/** Bumped on clear so in-flight read-modify-writes can detect staleness across SW/options contexts. */
export const LLM_METRICS_EPOCH_KEY = 'pagetollm-llm-metrics-epoch';
export const LLM_METRICS_MAX_RECENT = 40;

/** Human-readable labels for known task types (UI). */
export const LLM_TASK_TYPE_LABELS = Object.freeze({
  [LLM_TASK_TYPES.TOPIC_RANGES]: 'Topic ranges',
  [LLM_TASK_TYPES.ARTICLE_SUMMARY]: 'Article summary',
  [LLM_TASK_TYPES.TOPIC_SUMMARY_FROM_SOURCE]: 'Topic summary (from source)',
  [LLM_TASK_TYPES.ARTICLE_SUMMARY_MERGE]: 'Summary merge',
  [LLM_TASK_TYPES.CHAT_ANSWER]: 'Chat answer',
  [LLM_TASK_TYPES.CHAT_SYNTHESIS]: 'Chat synthesis',
  [LLM_TASK_TYPES.UNKNOWN]: 'Unknown',
});

const KNOWN_TASK_TYPES = new Set(Object.values(LLM_TASK_TYPES));

/**
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeTaskType(value) {
  if (typeof value !== 'string') return LLM_TASK_TYPES.UNKNOWN;
  const trimmed = value.trim();
  if (!trimmed) return LLM_TASK_TYPES.UNKNOWN;
  // Keep known ids as-is; allow future custom ids without crashing UI/storage.
  if (KNOWN_TASK_TYPES.has(trimmed)) return trimmed;
  // Sanitize free-form labels to a short stable key.
  const sanitized = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9_:-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  return sanitized || LLM_TASK_TYPES.UNKNOWN;
}

/**
 * @typedef {{
 *   inputTokens: number,
 *   outputTokens: number,
 *   totalTokens: number,
 *   reasoningTokens: number,
 *   cacheReadTokens: number,
 *   cacheWriteTokens: number,
 *   cacheMissTokens: number
 * }} LlmUsage
 */
/**
 * @typedef {{
 *   at: number,
 *   durationMs: number,
 *   ok: boolean,
 *   taskType: string,
 *   error: string,
 *   provider: string,
 *   model: string,
 *   requestChars: number,
 *   responseChars: number,
 *   usage: LlmUsage
 * }} LlmMetricEntry
 */
/**
 * @typedef {{
 *   totalCount: number,
 *   successCount: number,
 *   failureCount: number,
 *   totalDurationMs: number,
 *   minDurationMs: number | null,
 *   maxDurationMs: number | null,
 *   usageSampleCount: number,
 *   cacheSampleCount: number,
 *   totalInputTokens: number,
 *   totalOutputTokens: number,
 *   totalTokens: number,
 *   totalReasoningTokens: number,
 *   totalCacheReadTokens: number,
 *   totalCacheWriteTokens: number,
 *   totalCacheMissTokens: number,
 *   totalRequestChars: number,
 *   totalResponseChars: number
 * }} LlmMetricTotals
 */
/**
 * @typedef {{
 *   totalCount: number,
 *   successCount: number,
 *   failureCount: number,
 *   totalDurationMs: number,
 *   minDurationMs: number | null,
 *   maxDurationMs: number | null,
 *   usageSampleCount: number,
 *   cacheSampleCount: number,
 *   totalInputTokens: number,
 *   totalOutputTokens: number,
 *   totalTokens: number,
 *   totalReasoningTokens: number,
 *   totalCacheReadTokens: number,
 *   totalCacheWriteTokens: number,
 *   totalCacheMissTokens: number,
 *   totalRequestChars: number,
 *   totalResponseChars: number,
 *   epoch: number,
 *   recent: Array<LlmMetricEntry>,
 *   byTaskType: Record<string, LlmMetricTotals>
 * }} LlmMetrics
 */

/** @returns {LlmMetricTotals} */
export function emptyLlmMetricTotals() {
  return {
    totalCount: 0,
    successCount: 0,
    failureCount: 0,
    totalDurationMs: 0,
    minDurationMs: null,
    maxDurationMs: null,
    usageSampleCount: 0,
    cacheSampleCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalTokens: 0,
    totalReasoningTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    totalCacheMissTokens: 0,
    totalRequestChars: 0,
    totalResponseChars: 0,
  };
}

/** @param {number} [epoch]
 * @returns {LlmMetrics} */
export function emptyLlmMetrics(epoch = 0) {
  return {
    epoch,
    ...emptyLlmMetricTotals(),
    recent: [],
    byTaskType: {},
  };
}

/**
 * @param {unknown} value
 * @returns {LlmMetricTotals}
 */
function normalizeTotals(value) {
  if (!value || typeof value !== 'object') return emptyLlmMetricTotals();
  const v = /** @type {Record<string, unknown>} */ (value);
  const minRaw = v.minDurationMs;
  const maxRaw = v.maxDurationMs;
  return {
    totalCount: Math.max(0, Number(v.totalCount) || 0),
    successCount: Math.max(0, Number(v.successCount) || 0),
    failureCount: Math.max(0, Number(v.failureCount) || 0),
    totalDurationMs: Math.max(0, Number(v.totalDurationMs) || 0),
    minDurationMs: minRaw == null || minRaw === '' ? null : Math.max(0, Number(minRaw) || 0),
    maxDurationMs: maxRaw == null || maxRaw === '' ? null : Math.max(0, Number(maxRaw) || 0),
    usageSampleCount: Math.max(0, Number(v.usageSampleCount) || 0),
    cacheSampleCount: Math.max(0, Number(v.cacheSampleCount) || 0),
    totalInputTokens: Math.max(0, Number(v.totalInputTokens) || 0),
    totalOutputTokens: Math.max(0, Number(v.totalOutputTokens) || 0),
    totalTokens: Math.max(0, Number(v.totalTokens) || 0),
    totalReasoningTokens: Math.max(0, Number(v.totalReasoningTokens) || 0),
    totalCacheReadTokens: Math.max(0, Number(v.totalCacheReadTokens) || 0),
    totalCacheWriteTokens: Math.max(0, Number(v.totalCacheWriteTokens) || 0),
    totalCacheMissTokens: Math.max(0, Number(v.totalCacheMissTokens) || 0),
    totalRequestChars: Math.max(0, Number(v.totalRequestChars) || 0),
    totalResponseChars: Math.max(0, Number(v.totalResponseChars) || 0),
  };
}

/** @param {unknown} value
 * @returns {LlmUsage | undefined} */
export function normalizeLlmUsage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = /** @type {Record<string, unknown>} */ (value);
  /** @type {LlmUsage} */
  const usage = {};
  for (const key of [
    'inputTokens',
    'outputTokens',
    'totalTokens',
    'reasoningTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'cacheMissTokens',
  ]) {
    if (raw[key] == null || raw[key] === '') continue;
    const number = Number(raw[key]);
    if (Number.isFinite(number)) usage[key] = Math.max(0, number);
  }
  return Object.keys(usage).length ? usage : undefined;
}

/**
 * @param {unknown} value
 * @returns {Record<string, LlmMetricTotals>}
 */
function normalizeByTaskType(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  /** @type {Record<string, LlmMetricTotals>} */
  const out = {};
  for (const [rawKey, rawBucket] of Object.entries(
    /** @type {Record<string, unknown>} */ (value),
  )) {
    const key = normalizeTaskType(rawKey);
    const bucket = normalizeTotals(rawBucket);
    if (!bucket.totalCount && !bucket.successCount && !bucket.failureCount) continue;
    // If the same key appears twice after normalize (e.g. "Topic Ranges" + topic_ranges), merge.
    const prev = out[key];
    out[key] = prev ? mergeTotals(prev, bucket) : bucket;
  }
  return out;
}

/**
 * @param {LlmMetricTotals} a
 * @param {LlmMetricTotals} b
 * @returns {LlmMetricTotals}
 */
function mergeTotals(a, b) {
  const totalCount = a.totalCount + b.totalCount;
  const successCount = a.successCount + b.successCount;
  const failureCount = a.failureCount + b.failureCount;
  const totalDurationMs = a.totalDurationMs + b.totalDurationMs;
  let minDurationMs = a.minDurationMs;
  if (b.minDurationMs != null) {
    minDurationMs =
      minDurationMs == null ? b.minDurationMs : Math.min(minDurationMs, b.minDurationMs);
  }
  let maxDurationMs = a.maxDurationMs;
  if (b.maxDurationMs != null) {
    maxDurationMs =
      maxDurationMs == null ? b.maxDurationMs : Math.max(maxDurationMs, b.maxDurationMs);
  }
  return {
    totalCount,
    successCount,
    failureCount,
    totalDurationMs,
    minDurationMs,
    maxDurationMs,
    usageSampleCount: a.usageSampleCount + b.usageSampleCount,
    cacheSampleCount: a.cacheSampleCount + b.cacheSampleCount,
    totalInputTokens: a.totalInputTokens + b.totalInputTokens,
    totalOutputTokens: a.totalOutputTokens + b.totalOutputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    totalReasoningTokens: a.totalReasoningTokens + b.totalReasoningTokens,
    totalCacheReadTokens: a.totalCacheReadTokens + b.totalCacheReadTokens,
    totalCacheWriteTokens: a.totalCacheWriteTokens + b.totalCacheWriteTokens,
    totalCacheMissTokens: a.totalCacheMissTokens + b.totalCacheMissTokens,
    totalRequestChars: a.totalRequestChars + b.totalRequestChars,
    totalResponseChars: a.totalResponseChars + b.totalResponseChars,
  };
}

/**
 * @param {unknown} value
 * @returns {LlmMetrics}
 */
export function normalizeLlmMetrics(value) {
  if (!value || typeof value !== 'object') return emptyLlmMetrics();
  const v = /** @type {Record<string, unknown>} */ (value);
  const recent = Array.isArray(v.recent)
    ? v.recent
        .filter((e) => e && typeof e === 'object')
        .map((e) => {
          const entry = /** @type {Record<string, unknown>} */ (e);
          /** @type {LlmMetricEntry} */
          const out = {
            at: Number(entry.at) || 0,
            durationMs: Math.max(0, Number(entry.durationMs) || 0),
            ok: entry.ok !== false,
            taskType: normalizeTaskType(entry.taskType),
          };
          if (typeof entry.error === 'string' && entry.error) out.error = entry.error;
          if (typeof entry.provider === 'string' && entry.provider.trim()) {
            out.provider = entry.provider.trim().slice(0, 80);
          }
          if (typeof entry.model === 'string' && entry.model.trim()) {
            out.model = entry.model.trim().slice(0, 160);
          }
          if (entry.requestChars != null && Number.isFinite(Number(entry.requestChars))) {
            out.requestChars = Math.max(0, Number(entry.requestChars));
          }
          if (entry.responseChars != null && Number.isFinite(Number(entry.responseChars))) {
            out.responseChars = Math.max(0, Number(entry.responseChars));
          }
          const usage = normalizeLlmUsage(entry.usage);
          if (usage) out.usage = usage;
          return out;
        })
        .slice(0, LLM_METRICS_MAX_RECENT)
    : [];
  const totals = normalizeTotals(v);
  return {
    epoch: Math.max(0, Number(v.epoch) || 0),
    ...totals,
    recent,
    byTaskType: normalizeByTaskType(v.byTaskType),
  };
}

/**
 * Wraps `callLLMWithRetry` so every orchestrator LLM call records duration.
 * Failures while recording never affect the LLM call itself.
 *
 * Pass `taskType` on the options object to separate metrics by pipeline stage
 * (e.g. `LLM_TASK_TYPES.TOPIC_RANGES`). Unknown / missing values become "unknown".
 *
 * @template {(...args: any[]) => Promise<any>} F
 * @param {F} callLLMWithRetry
 * @returns {F}
 */
export function wrapCallLLMWithRetry(callLLMWithRetry) {
  return /** @type {F} */ (
    async function timedCallLLMWithRetry(opts, maxRetries) {
      const taskType = normalizeTaskType(opts?.taskType);
      const startedAt = Date.now();
      let responseMetric;
      const upstreamCollector = opts?.metricsCollector;
      const metricsCollector = (sample) => {
        if (sample && typeof sample === 'object') responseMetric = sample;
        if (typeof upstreamCollector === 'function') upstreamCollector(sample);
      };
      const measuredOpts = opts && typeof opts === 'object' ? { ...opts, metricsCollector } : opts;
      try {
        const result = await callLLMWithRetry(measuredOpts, maxRetries);
        void recordLlmMetric({
          durationMs: Date.now() - startedAt,
          ok: true,
          taskType,
          ...responseMetric,
        });
        return result;
      } catch (err) {
        void recordLlmMetric({
          durationMs: Date.now() - startedAt,
          ok: false,
          taskType,
          error: (err && err.message) || String(err),
        });
        throw err;
      }
    }
  );
}

// Serialize metric mutations within one JS realm (service worker or options page).
/** @type {Promise<void>} */
let writeChain = Promise.resolve();

/**
 * @param {function(): Promise<void>} fn
 * @returns {Promise<void>}
 */
function enqueueWrite(fn) {
  const job = writeChain.then(fn, fn);
  writeChain = job.catch(() => {});
  return job;
}

/**
 * @param {LlmMetricTotals} current
 * @param {LlmMetricEntry} entry
 * @returns {LlmMetricTotals}
 */
function applyTotals(current, entry) {
  const usage = entry.usage || {};
  return {
    totalCount: current.totalCount + 1,
    successCount: current.successCount + (entry.ok ? 1 : 0),
    failureCount: current.failureCount + (entry.ok ? 0 : 1),
    totalDurationMs: current.totalDurationMs + entry.durationMs,
    minDurationMs:
      current.minDurationMs == null
        ? entry.durationMs
        : Math.min(current.minDurationMs, entry.durationMs),
    maxDurationMs:
      current.maxDurationMs == null
        ? entry.durationMs
        : Math.max(current.maxDurationMs, entry.durationMs),
    usageSampleCount: current.usageSampleCount + (entry.usage ? 1 : 0),
    cacheSampleCount:
      current.cacheSampleCount +
      (entry.usage &&
      ['cacheReadTokens', 'cacheWriteTokens', 'cacheMissTokens'].some(
        (key) => entry.usage[key] !== undefined,
      )
        ? 1
        : 0),
    totalInputTokens: current.totalInputTokens + (usage.inputTokens || 0),
    totalOutputTokens: current.totalOutputTokens + (usage.outputTokens || 0),
    totalTokens: current.totalTokens + (usage.totalTokens || 0),
    totalReasoningTokens: current.totalReasoningTokens + (usage.reasoningTokens || 0),
    totalCacheReadTokens: current.totalCacheReadTokens + (usage.cacheReadTokens || 0),
    totalCacheWriteTokens: current.totalCacheWriteTokens + (usage.cacheWriteTokens || 0),
    totalCacheMissTokens: current.totalCacheMissTokens + (usage.cacheMissTokens || 0),
    totalRequestChars: current.totalRequestChars + (entry.requestChars || 0),
    totalResponseChars: current.totalResponseChars + (entry.responseChars || 0),
  };
}

/**
 * @param {LlmMetrics} current
 * @param {LlmMetricEntry} entry
 * @returns {LlmMetrics}
 */
function applyMetric(current, entry) {
  const recent = [entry, ...current.recent].slice(0, LLM_METRICS_MAX_RECENT);
  const taskType = normalizeTaskType(entry.taskType);
  const prevBucket = current.byTaskType?.[taskType] || emptyLlmMetricTotals();
  const nextTotals = applyTotals(current, entry);
  return {
    epoch: current.epoch || 0,
    ...nextTotals,
    recent,
    byTaskType: {
      ...(current.byTaskType || {}),
      [taskType]: applyTotals(prevBucket, entry),
    },
  };
}

/**
 * @param {object} entry
 * @param {number} entry.durationMs
 * @param {boolean} entry.ok
 * @param {string} [entry.taskType]
 * @param {string} [entry.error]
 * @param {string} [entry.provider]
 * @param {string} [entry.model]
 * @param {number} [entry.requestChars]
 * @param {number} [entry.responseChars]
 * @param {LlmUsage} [entry.usage]
 * @returns {Promise<void>}
 */
export function recordLlmMetric(entry) {
  const durationMs = Math.max(0, Number(entry?.durationMs) || 0);
  const ok = entry?.ok !== false;
  const taskType = normalizeTaskType(entry?.taskType);
  const error = !ok && typeof entry?.error === 'string' && entry.error ? entry.error : undefined;
  const at = Date.now();

  /** @type {LlmMetricEntry} */
  const nextEntry = { at, durationMs, ok, taskType };
  if (error) nextEntry.error = error;
  if (typeof entry?.provider === 'string' && entry.provider.trim()) {
    nextEntry.provider = entry.provider.trim().slice(0, 80);
  }
  if (typeof entry?.model === 'string' && entry.model.trim()) {
    nextEntry.model = entry.model.trim().slice(0, 160);
  }
  if (entry?.requestChars != null && Number.isFinite(Number(entry.requestChars))) {
    nextEntry.requestChars = Math.max(0, Number(entry.requestChars));
  }
  if (entry?.responseChars != null && Number.isFinite(Number(entry.responseChars))) {
    nextEntry.responseChars = Math.max(0, Number(entry.responseChars));
  }
  const usage = normalizeLlmUsage(entry?.usage);
  if (usage) nextEntry.usage = usage;

  return enqueueWrite(async () => {
    try {
      // Retry when a clear lands mid read-modify-write. Options page and the
      // service worker do not share this writeChain, so epoch reconciliation
      // is what prevents pre-clear aggregates from reappearing.
      for (let attempt = 0; attempt < 5; attempt++) {
        const epoch = await getMetricsEpoch();
        // Sample completed at or before the last clear — drop it.
        if (at <= epoch) return;

        const stored = await readLlmMetricsRaw();
        // Ignore payload from an older epoch (e.g. stale overwrite after clear).
        const current = (stored.epoch || 0) === epoch ? stored : emptyLlmMetrics(epoch);

        const next = applyMetric(current, nextEntry);
        next.epoch = epoch;
        await writeLlmMetricsRaw(next);

        const epochAfter = await getMetricsEpoch();
        if (epochAfter === epoch) return;
      }
    } catch (err) {
      console.warn('PageToLLM Canvas LLM metrics record failed:', err);
    }
  });
}

/** @returns {Promise<number>} */
function getMetricsEpoch() {
  return new Promise((resolve) => {
    try {
      if (typeof chrome === 'undefined' || !chrome?.storage?.local) {
        resolve(0);
        return;
      }
      chrome.storage.local.get(LLM_METRICS_EPOCH_KEY, (items) => {
        if (chrome.runtime && chrome.runtime.lastError) {
          resolve(0);
          return;
        }
        const raw = items ? items[LLM_METRICS_EPOCH_KEY] : 0;
        resolve(Math.max(0, Number(raw) || 0));
      });
    } catch (_) {
      resolve(0);
    }
  });
}

/** @returns {Promise<LlmMetrics>} */
function readLlmMetricsRaw() {
  return new Promise((resolve) => {
    try {
      if (typeof chrome === 'undefined' || !chrome?.storage?.local) {
        resolve(emptyLlmMetrics());
        return;
      }
      chrome.storage.local.get(LLM_METRICS_KEY, (items) => {
        if (chrome.runtime && chrome.runtime.lastError) {
          resolve(emptyLlmMetrics());
          return;
        }
        resolve(normalizeLlmMetrics(items ? items[LLM_METRICS_KEY] : undefined));
      });
    } catch (_) {
      resolve(emptyLlmMetrics());
    }
  });
}

/**
 * Reads metrics, discarding payloads that do not match the current clear epoch.
 * @returns {Promise<LlmMetrics>}
 */
export async function getLlmMetrics() {
  try {
    if (typeof chrome === 'undefined' || !chrome?.storage?.local) {
      return emptyLlmMetrics();
    }
    const items = await new Promise((resolve) => {
      try {
        chrome.storage.local.get([LLM_METRICS_KEY, LLM_METRICS_EPOCH_KEY], (result) => {
          if (chrome.runtime && chrome.runtime.lastError) {
            resolve({});
            return;
          }
          resolve(result || {});
        });
      } catch (_) {
        resolve({});
      }
    });
    const epoch = Math.max(0, Number(items[LLM_METRICS_EPOCH_KEY]) || 0);
    const metrics = normalizeLlmMetrics(items[LLM_METRICS_KEY]);
    if ((metrics.epoch || 0) !== epoch) return emptyLlmMetrics(epoch);
    return metrics;
  } catch (_) {
    return emptyLlmMetrics();
  }
}

/**
 * @param {LlmMetrics} metrics
 * @returns {Promise<void>}
 */
function writeLlmMetricsRaw(metrics) {
  return new Promise((resolve, reject) => {
    try {
      if (typeof chrome === 'undefined' || !chrome?.storage?.local) {
        resolve();
        return;
      }
      chrome.storage.local.set({ [LLM_METRICS_KEY]: metrics }, () => {
        if (chrome.runtime && chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message || 'storage.set failed'));
          return;
        }
        resolve();
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/**
 * Clears metrics and bumps an epoch so in-flight record jobs cannot restore
 * pre-clear aggregates (options page and service worker do not share memory).
 * @returns {Promise<void>}
 */
export function clearLlmMetrics() {
  return enqueueWrite(async () => {
    try {
      if (typeof chrome === 'undefined' || !chrome?.storage?.local) {
        return;
      }
      const epoch = Date.now();
      await new Promise((resolve, reject) => {
        try {
          // Atomic multi-key set: epoch + empty payload together.
          chrome.storage.local.set(
            {
              [LLM_METRICS_EPOCH_KEY]: epoch,
              [LLM_METRICS_KEY]: emptyLlmMetrics(epoch),
            },
            () => {
              if (chrome.runtime && chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message || 'storage.set failed'));
                return;
              }
              resolve();
            },
          );
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    } catch (err) {
      console.warn('PageToLLM Canvas LLM metrics clear failed:', err);
      throw err;
    }
  });
}
