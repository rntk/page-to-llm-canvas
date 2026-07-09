// Persisted "disable summary generation" toggle. When enabled, the pipeline
// still cleans the HTML, splits sentences, and computes topic ranges, but skips
// every summary LLM call and finalizes the record with empty summaries. Stored
// in chrome.storage.local so both the options UI (src/options) and the
// service-worker pipeline (worker/orchestrator) can read it. Defaults to off
// (summaries enabled), and every accessor degrades to the default rather than
// throwing so a storage hiccup never breaks the pipeline.

export const SUMMARIES_DISABLED_KEY = 'pagetollm-summaries-disabled';
export const DEFAULT_SUMMARIES_DISABLED = false;

export function normalizeSummariesDisabled(value) {
  return value === true;
}

export function getStoredSummariesDisabled() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(SUMMARIES_DISABLED_KEY, (items) => {
        if (chrome.runtime && chrome.runtime.lastError) {
          resolve(DEFAULT_SUMMARIES_DISABLED);
          return;
        }
        resolve(normalizeSummariesDisabled(items ? items[SUMMARIES_DISABLED_KEY] : undefined));
      });
    } catch (_) {
      resolve(DEFAULT_SUMMARIES_DISABLED);
    }
  });
}

export function setStoredSummariesDisabled(value) {
  const normalized = normalizeSummariesDisabled(value);
  return new Promise((resolve, reject) => {
    try {
      chrome.storage.local.set({ [SUMMARIES_DISABLED_KEY]: normalized }, () => {
        if (chrome.runtime && chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message || 'storage.set failed'));
          return;
        }
        resolve(normalized);
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}
