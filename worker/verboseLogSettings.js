// Persisted verbose diagnostics toggle. When enabled, the orchestrator writes
// a processingLog entry (and console.info) for every stage — including
// per-chunk / per-topic LLM request and response events — and article chat
// logs its per-chunk/tool details to the page console. When disabled, only
// high-level lifecycle and error stages are recorded, which keeps consoles and
// the record's processingLog much quieter.
//
// Stored in chrome.storage.local so both the options UI (src/options) and the
// service-worker pipeline (worker/orchestrator) can read it. Defaults to off
// (quiet), and every accessor degrades to the default rather than throwing so
// a storage hiccup never breaks the pipeline.

export const VERBOSE_LOGS_KEY = 'pagetollm-verbose-logs';
export const DEFAULT_VERBOSE_LOGS = false;

export function normalizeVerboseLogs(value) {
  return value === true;
}

export function getStoredVerboseLogs() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(VERBOSE_LOGS_KEY, (items) => {
        if (chrome.runtime && chrome.runtime.lastError) {
          resolve(DEFAULT_VERBOSE_LOGS);
          return;
        }
        resolve(normalizeVerboseLogs(items ? items[VERBOSE_LOGS_KEY] : undefined));
      });
    } catch (_) {
      resolve(DEFAULT_VERBOSE_LOGS);
    }
  });
}

export function setStoredVerboseLogs(value) {
  const normalized = normalizeVerboseLogs(value);
  return new Promise((resolve, reject) => {
    try {
      chrome.storage.local.set({ [VERBOSE_LOGS_KEY]: normalized }, () => {
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
