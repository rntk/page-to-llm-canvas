// Persisted timeout for one provider-facing LLM request. The value is stored in
// seconds because that is the unit shown on the options page, then converted to
// milliseconds at the request boundary.

export const LLM_REQUEST_TIMEOUT_SECONDS_KEY = 'pagetollm-llm-request-timeout-seconds';
export const DEFAULT_LLM_REQUEST_TIMEOUT_SECONDS = 120;
export const MIN_LLM_REQUEST_TIMEOUT_SECONDS = 1;
export const MAX_LLM_REQUEST_TIMEOUT_SECONDS = 86_400;

export function normalizeLlmRequestTimeoutSeconds(value) {
  const parsed = typeof value === 'number' ? Math.trunc(value) : Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_LLM_REQUEST_TIMEOUT_SECONDS;
  return Math.min(
    MAX_LLM_REQUEST_TIMEOUT_SECONDS,
    Math.max(MIN_LLM_REQUEST_TIMEOUT_SECONDS, parsed),
  );
}

export function getStoredLlmRequestTimeoutSeconds() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(LLM_REQUEST_TIMEOUT_SECONDS_KEY, (items) => {
        if (chrome.runtime && chrome.runtime.lastError) {
          resolve(DEFAULT_LLM_REQUEST_TIMEOUT_SECONDS);
          return;
        }
        resolve(
          normalizeLlmRequestTimeoutSeconds(
            items ? items[LLM_REQUEST_TIMEOUT_SECONDS_KEY] : undefined,
          ),
        );
      });
    } catch (_) {
      resolve(DEFAULT_LLM_REQUEST_TIMEOUT_SECONDS);
    }
  });
}

export function setStoredLlmRequestTimeoutSeconds(value) {
  const normalized = normalizeLlmRequestTimeoutSeconds(value);
  return new Promise((resolve, reject) => {
    try {
      chrome.storage.local.set({ [LLM_REQUEST_TIMEOUT_SECONDS_KEY]: normalized }, () => {
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
