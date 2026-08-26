// Persisted cap for provider-facing LLM work started by the article pipeline.
// The orchestrator applies one shared limit across every page being processed,
// preventing per-page parallelism from multiplying into an unbounded burst.

import { createStoredSetting, normalizeClampedInt } from '../../src/shared/runtime/localStore.js';

export const MAX_PARALLEL_LLM_REQUESTS_KEY = 'pagetollm-max-parallel-llm-requests';
export const DEFAULT_MAX_PARALLEL_LLM_REQUESTS = 4;
export const MIN_PARALLEL_LLM_REQUESTS = 1;
export const MAX_PARALLEL_LLM_REQUESTS = 16;

export function normalizeMaxParallelLlmRequests(value) {
  return normalizeClampedInt(value, {
    min: MIN_PARALLEL_LLM_REQUESTS,
    max: MAX_PARALLEL_LLM_REQUESTS,
    fallback: DEFAULT_MAX_PARALLEL_LLM_REQUESTS,
  });
}

const setting = createStoredSetting({
  key: MAX_PARALLEL_LLM_REQUESTS_KEY,
  defaultValue: DEFAULT_MAX_PARALLEL_LLM_REQUESTS,
  normalize: normalizeMaxParallelLlmRequests,
});

export function getStoredMaxParallelLlmRequests() {
  return setting.read();
}

export function setStoredMaxParallelLlmRequests(value) {
  return setting.write(value);
}
