// Persisted timeout for one provider-facing LLM request. The value is stored in
// seconds because that is the unit shown on the options page, then converted to
// milliseconds at the request boundary.

import { createStoredSetting, normalizeClampedInt } from '../../src/shared/runtime/localStore.js';

export const LLM_REQUEST_TIMEOUT_SECONDS_KEY = 'pagetollm-llm-request-timeout-seconds';
export const DEFAULT_LLM_REQUEST_TIMEOUT_SECONDS = 120;
export const MIN_LLM_REQUEST_TIMEOUT_SECONDS = 1;
export const MAX_LLM_REQUEST_TIMEOUT_SECONDS = 86_400;

export function normalizeLlmRequestTimeoutSeconds(value) {
  return normalizeClampedInt(value, {
    min: MIN_LLM_REQUEST_TIMEOUT_SECONDS,
    max: MAX_LLM_REQUEST_TIMEOUT_SECONDS,
    fallback: DEFAULT_LLM_REQUEST_TIMEOUT_SECONDS,
  });
}

const setting = createStoredSetting({
  key: LLM_REQUEST_TIMEOUT_SECONDS_KEY,
  defaultValue: DEFAULT_LLM_REQUEST_TIMEOUT_SECONDS,
  normalize: normalizeLlmRequestTimeoutSeconds,
});

export function getStoredLlmRequestTimeoutSeconds() {
  return setting.read();
}

export function setStoredLlmRequestTimeoutSeconds(value) {
  return setting.write(value);
}
