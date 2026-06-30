// Persisted "prefer the language of the content" toggle. When enabled, the
// pipeline asks the model to write its human-readable output (topic labels and
// summaries) in the dominant language of the analyzed content instead of
// defaulting to English. Stored in chrome.storage.local so both the options UI
// (src/options) and the service-worker pipeline (worker/orchestrator) can read
// it. Defaults to off, and every accessor degrades to the default rather than
// throwing so a storage hiccup never breaks the pipeline.

export const PREFER_CONTENT_LANGUAGE_KEY = 'pagetollm-prefer-content-language';
export const DEFAULT_PREFER_CONTENT_LANGUAGE = false;

export function normalizePreferContentLanguage(value) {
  return value === true;
}

export function getStoredPreferContentLanguage() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(PREFER_CONTENT_LANGUAGE_KEY, (items) => {
        if (chrome.runtime && chrome.runtime.lastError) {
          resolve(DEFAULT_PREFER_CONTENT_LANGUAGE);
          return;
        }
        resolve(normalizePreferContentLanguage(items ? items[PREFER_CONTENT_LANGUAGE_KEY] : undefined));
      });
    } catch (_) {
      resolve(DEFAULT_PREFER_CONTENT_LANGUAGE);
    }
  });
}

export function setStoredPreferContentLanguage(value) {
  const normalized = normalizePreferContentLanguage(value);
  return new Promise((resolve, reject) => {
    try {
      chrome.storage.local.set({ [PREFER_CONTENT_LANGUAGE_KEY]: normalized }, () => {
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
