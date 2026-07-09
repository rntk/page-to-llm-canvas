// Isolated LLM request duration metrics.
//
// TO REMOVE ENTIRELY:
//   1. Delete this file (and llmMetrics.test.js)
//   2. In orchestrator.js: remove the llmMetrics import + wrap lines; restore
//      a plain `callLLMWithRetry` import from ./llm.js
//   3. In OptionsApp.jsx: remove LlmMetricsSection + its import + render

export const LLM_METRICS_KEY = 'pagetollm-llm-metrics';
/** Bumped on clear so in-flight read-modify-writes can detect staleness across SW/options contexts. */
export const LLM_METRICS_EPOCH_KEY = 'pagetollm-llm-metrics-epoch';
export const LLM_METRICS_MAX_RECENT = 40;

/** @typedef {{ at: number, durationMs: number, ok: boolean, error?: string }} LlmMetricEntry */
/**
 * @typedef {{
 *   epoch: number,
 *   totalCount: number,
 *   successCount: number,
 *   failureCount: number,
 *   totalDurationMs: number,
 *   minDurationMs: number | null,
 *   maxDurationMs: number | null,
 *   recent: LlmMetricEntry[],
 * }} LlmMetrics
 */

/** @param {number} [epoch]
 * @returns {LlmMetrics} */
export function emptyLlmMetrics(epoch = 0) {
  return {
    epoch,
    totalCount: 0,
    successCount: 0,
    failureCount: 0,
    totalDurationMs: 0,
    minDurationMs: null,
    maxDurationMs: null,
    recent: [],
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
          };
          if (typeof entry.error === 'string' && entry.error) out.error = entry.error;
          return out;
        })
        .slice(0, LLM_METRICS_MAX_RECENT)
    : [];
  const totalCount = Math.max(0, Number(v.totalCount) || 0);
  const successCount = Math.max(0, Number(v.successCount) || 0);
  const failureCount = Math.max(0, Number(v.failureCount) || 0);
  const totalDurationMs = Math.max(0, Number(v.totalDurationMs) || 0);
  const minRaw = v.minDurationMs;
  const maxRaw = v.maxDurationMs;
  return {
    epoch: Math.max(0, Number(v.epoch) || 0),
    totalCount,
    successCount,
    failureCount,
    totalDurationMs,
    minDurationMs:
      minRaw == null || minRaw === '' ? null : Math.max(0, Number(minRaw) || 0),
    maxDurationMs:
      maxRaw == null || maxRaw === '' ? null : Math.max(0, Number(maxRaw) || 0),
    recent,
  };
}

/**
 * Average duration in ms, or null when there are no samples.
 * @param {LlmMetrics} metrics
 * @returns {number | null}
 */
export function averageDurationMs(metrics) {
  if (!metrics || !metrics.totalCount) return null;
  return metrics.totalDurationMs / metrics.totalCount;
}

/**
 * @param {number | null | undefined} ms
 * @returns {string}
 */
export function formatDurationMs(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 2 : 1)} s`;
  const minutes = Math.floor(seconds / 60);
  const rem = seconds - minutes * 60;
  return `${minutes}m ${rem.toFixed(0)}s`;
}

/**
 * Wraps `callLLMWithRetry` so every orchestrator LLM call records duration.
 * Failures while recording never affect the LLM call itself.
 *
 * @template {(...args: any[]) => Promise<any>} F
 * @param {F} callLLMWithRetry
 * @returns {F}
 */
export function wrapCallLLMWithRetry(callLLMWithRetry) {
  return /** @type {F} */ (
    async function timedCallLLMWithRetry(opts, maxRetries) {
      const startedAt = Date.now();
      try {
        const result = await callLLMWithRetry(opts, maxRetries);
        void recordLlmMetric({
          durationMs: Date.now() - startedAt,
          ok: true,
        });
        return result;
      } catch (err) {
        void recordLlmMetric({
          durationMs: Date.now() - startedAt,
          ok: false,
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
 * @param {() => Promise<void>} fn
 * @returns {Promise<void>}
 */
function enqueueWrite(fn) {
  const job = writeChain.then(fn, fn);
  writeChain = job.catch(() => {});
  return job;
}

/**
 * @param {LlmMetrics} current
 * @param {LlmMetricEntry} entry
 * @returns {LlmMetrics}
 */
function applyMetric(current, entry) {
  const recent = [entry, ...current.recent].slice(0, LLM_METRICS_MAX_RECENT);
  return {
    epoch: current.epoch || 0,
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
    recent,
  };
}

/**
 * @param {{ durationMs: number, ok: boolean, error?: string }} entry
 * @returns {Promise<void>}
 */
export function recordLlmMetric(entry) {
  const durationMs = Math.max(0, Number(entry?.durationMs) || 0);
  const ok = entry?.ok !== false;
  const error =
    !ok && typeof entry?.error === 'string' && entry.error ? entry.error : undefined;
  const at = Date.now();

  /** @type {LlmMetricEntry} */
  const nextEntry = { at, durationMs, ok };
  if (error) nextEntry.error = error;

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
        const current =
          (stored.epoch || 0) === epoch ? stored : emptyLlmMetrics(epoch);

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
