// Realm-neutral persistence boundary for the shared verbose diagnostics flag.
// UI bundles and the extension worker can both use this module without either
// layer importing the other's implementation directory.

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
