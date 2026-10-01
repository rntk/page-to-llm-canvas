// Watch local records and session pipeline failures, both of which affect the
// records list. Keys are copied from worker modules to keep them out of this bundle.

const RECORD_INDEX_KEY = 'pagetollm:index';
const RECORD_STORAGE_PREFIX = 'pagetollm:rec:';
const PIPELINE_FAILURE_BREAKER_KEY = 'pagetollm:pipeline-failure-breakers';

/**
 * Whether one storage event may have changed the records list.
 *
 * @param {Object|null} changes Chrome change records, keyed by storage key.
 * @param {string} areaName Storage area the event fired for.
 * @returns {boolean} True when the records list may be stale.
 */
export function isRecordStorageChange(changes, areaName) {
  if (!changes || typeof changes !== 'object') return false;
  if (areaName === 'local') {
    return Object.keys(changes).some(
      (key) => key === RECORD_INDEX_KEY || key.startsWith(RECORD_STORAGE_PREFIX),
    );
  }
  if (areaName === 'session') {
    return Object.hasOwn(changes, PIPELINE_FAILURE_BREAKER_KEY);
  }
  return false;
}

/**
 * Subscribe to relevant storage changes. Returns a safe no-op unsubscribe
 * when the Chrome storage event is unavailable.
 *
 * @param {function(): void} onChange Refresh trigger, takes no arguments.
 * @returns {function(): void} Unsubscribe.
 */
export function subscribeRecordChanges(onChange) {
  const handler = (changes, areaName) => {
    if (isRecordStorageChange(changes, areaName)) onChange();
  };
  let storageChanges;
  try {
    storageChanges = globalThis.chrome?.storage?.onChanged;
    if (!storageChanges || typeof storageChanges.addListener !== 'function') {
      return () => {};
    }
    storageChanges.addListener(handler);
  } catch (_) {
    return () => {};
  }
  return () => {
    try {
      storageChanges.removeListener(handler);
    } catch (_) {
      /* noop */
    }
  };
}
