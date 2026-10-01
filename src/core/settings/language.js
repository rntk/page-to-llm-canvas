// Shared setting for topic labels and summaries in the content's language.
// Defaults to off; storage failures fall back to the default.

import { createStoredSetting } from '../../shared/runtime/localStore.js';

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
