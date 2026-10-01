// Shared verbose diagnostics setting for the UI and worker. Enabling it logs
// per-stage pipeline and article-chat details. Defaults to off, including on
// storage failures.

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
