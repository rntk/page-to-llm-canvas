// Persisted "disable summary generation" toggle. When enabled, a pipeline run
// still cleans the HTML, splits sentences, and computes topic ranges, but skips
// every summary LLM call and finalizes the record with empty summaries.
//
// This is only the *default* for new runs: background.js reads it once at run
// kickoff (submit/retry/reprocess) and persists the decision on the record as
// the `skipSummaries` run directive, which is what the orchestrator actually
// obeys. The per-record "Generate summaries" action sets that directive to
// false explicitly, overriding this toggle for one run. Stored in
// chrome.storage.local so both the options UI (src/options) and the service
// worker (background.js) can read it. Defaults to off (summaries enabled), and
// every accessor degrades to the default rather than throwing so a storage
// hiccup never breaks the pipeline.

import { createStoredSetting } from '../../src/shared/runtime/localStore.js';

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
