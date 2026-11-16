// When true, new runs skip summary calls after topic ranges. The worker saves
// it as the record's skipSummaries directive; "Generate summaries" overrides it
// for one run. Defaults to false; storage failures also yield summaries enabled.

import { createStoredSetting } from '../../shared/runtime/localStore.js';

export const SUMMARIES_DISABLED_KEY = 'pagetollm-summaries-disabled';
export const DEFAULT_SUMMARIES_DISABLED = false;

export function normalizeSummariesDisabled(value) {
  return value === true;
}

const setting = createStoredSetting({
  key: SUMMARIES_DISABLED_KEY,
  defaultValue: DEFAULT_SUMMARIES_DISABLED,
  normalize: normalizeSummariesDisabled,
});

export function getStoredSummariesDisabled() {
  return setting.read();
}

export function setStoredSummariesDisabled(value) {
  return setting.write(value);
}
