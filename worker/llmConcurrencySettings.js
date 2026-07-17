// Persisted cap for provider-facing LLM work started by the article pipeline.
// The orchestrator applies one shared limit across every page being processed,
// preventing per-page parallelism from multiplying into an unbounded burst.

export const MAX_PARALLEL_LLM_REQUESTS_KEY = 'pagetollm-max-parallel-llm-requests';
export const DEFAULT_MAX_PARALLEL_LLM_REQUESTS = 4;
export const MIN_PARALLEL_LLM_REQUESTS = 1;
export const MAX_PARALLEL_LLM_REQUESTS = 16;

export function normalizeMaxParallelLlmRequests(value) {
  const parsed = typeof value === 'number' ? Math.trunc(value) : Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_PARALLEL_LLM_REQUESTS;
  return Math.min(MAX_PARALLEL_LLM_REQUESTS, Math.max(MIN_PARALLEL_LLM_REQUESTS, parsed));
}

export function getStoredMaxParallelLlmRequests() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(MAX_PARALLEL_LLM_REQUESTS_KEY, (items) => {
        if (chrome.runtime && chrome.runtime.lastError) {
          resolve(DEFAULT_MAX_PARALLEL_LLM_REQUESTS);
          return;
        }
        resolve(
          normalizeMaxParallelLlmRequests(items ? items[MAX_PARALLEL_LLM_REQUESTS_KEY] : undefined),
        );
      });
    } catch (_) {
      resolve(DEFAULT_MAX_PARALLEL_LLM_REQUESTS);
    }
  });
}

export function setStoredMaxParallelLlmRequests(value) {
  const normalized = normalizeMaxParallelLlmRequests(value);
  return new Promise((resolve, reject) => {
    try {
      chrome.storage.local.set({ [MAX_PARALLEL_LLM_REQUESTS_KEY]: normalized }, () => {
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
