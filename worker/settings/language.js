// Persisted "prefer the language of the content" toggle. When enabled, the
// pipeline asks the model to write its human-readable output (topic labels and
// summaries) in the dominant language of the analyzed content instead of
// defaulting to English. Stored in chrome.storage.local so both the options UI
// (src/options) and the service-worker pipeline (worker/orchestrator) can read
// it. Defaults to off, and every accessor degrades to the default rather than
// throwing so a storage hiccup never breaks the pipeline.

import { createStoredSetting } from '../../src/shared/runtime/localStore.js';

export const PREFER_CONTENT_LANGUAGE_KEY = 'pagetollm-prefer-content-language';
export const DEFAULT_PREFER_CONTENT_LANGUAGE = false;

export function normalizePreferContentLanguage(value) {
  return value === true;
}

const setting = createStoredSetting({
  key: PREFER_CONTENT_LANGUAGE_KEY,
  defaultValue: DEFAULT_PREFER_CONTENT_LANGUAGE,
  normalize: normalizePreferContentLanguage,
});

export function getStoredPreferContentLanguage() {
  return setting.read();
}

export function setStoredPreferContentLanguage(value) {
  return setting.write(value);
}
