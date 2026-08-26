// Realm-neutral persistence boundary for the shared verbose diagnostics flag.
// UI bundles and the extension worker can both use this module without either
// layer importing the other's implementation directory.
//
// When enabled, the orchestrator writes a processingLog entry (and
// console.info) for every stage — including per-chunk / per-topic LLM request
// and response events — and article chat logs its per-chunk/tool details to the
// page console. When disabled, only high-level lifecycle and error stages are
// recorded, which keeps consoles and the record's processingLog much quieter.
//
// Stored in chrome.storage.local so both the options UI (src/options) and the
// service-worker pipeline (worker/orchestrator) can read it. Defaults to off
// (quiet), and every accessor degrades to the default rather than throwing so a
// storage hiccup never breaks the pipeline.

import { createStoredSetting } from './localStore.js';

export const VERBOSE_LOGS_KEY = 'pagetollm-verbose-logs';
export const DEFAULT_VERBOSE_LOGS = false;

export function normalizeVerboseLogs(value) {
  return value === true;
}

const setting = createStoredSetting({
  key: VERBOSE_LOGS_KEY,
  defaultValue: DEFAULT_VERBOSE_LOGS,
  normalize: normalizeVerboseLogs,
});

export function getStoredVerboseLogs() {
  return setting.read();
}

export function setStoredVerboseLogs(value) {
  return setting.write(value);
}
