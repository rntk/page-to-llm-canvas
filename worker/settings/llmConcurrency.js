// Persisted cap for provider-facing LLM work started by the article pipeline.
// The orchestrator applies one shared limit across every page being processed,
// preventing per-page parallelism from multiplying into an unbounded burst.

import { createStoredSetting } from '../../src/shared/runtime/localStore.js';

export const MAX_PARALLEL_LLM_REQUESTS_KEY = 'pagetollm-max-parallel-llm-requests';
export const DEFAULT_MAX_PARALLEL_LLM_REQUESTS = 4;
export const MIN_PARALLEL_LLM_REQUESTS = 1;
export const MAX_PARALLEL_LLM_REQUESTS = 16;

export function normalizeMaxParallelLlmRequests(value) {
  const parsed = typeof value === 'number' ? Math.trunc(value) : Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_PARALLEL_LLM_REQUESTS;
  return Math.min(MAX_PARALLEL_LLM_REQUESTS, Math.max(MIN_PARALLEL_LLM_REQUESTS, parsed));
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
