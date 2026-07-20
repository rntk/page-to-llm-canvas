// Realm-neutral persistence boundary for the shared verbose diagnostics flag.
// UI bundles and the extension worker can both use this module without either
// layer importing the other's implementation directory.

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
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
