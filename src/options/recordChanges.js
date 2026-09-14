// Browser-backed "records may have changed" subscription for the options page.
//
// `RecordsSection` used to reach `globalThis.chrome.storage.onChanged` directly
// from its effect. The other options sections take their storage boundary as an
// injected capability (`store.subscribe`, `fileHost`, `pageHost`), so this
// module provides the same for record refreshes: consumers take a
// `subscribeRecords(onChange) => unsubscribe` function and never see the raw
// `(changes, areaName)` event shape, which also makes them testable with a
// plain fake.
//
// The watched keys mirror what the section filtered inline before:
// - `local`: the record index plus every per-record key, and
// - `session`: the pipeline-failure breaker entry (list responses project
//   session-backed pipeline failures as errors).
//
// Key spellings are duplicated here deliberately: the canonical owners live in
// worker-side modules (`src/core/storage/recordIndex.js`,
// `src/extension/background/pipelineFailureBreaker.js`) that the options
// bundle does not import, and the previous inline filter spelled them out too.

const RECORD_INDEX_KEY = 'pagetollm:index';
const RECORD_STORAGE_PREFIX = 'pagetollm:rec:';
const PIPELINE_FAILURE_BREAKER_KEY = 'pagetollm:pipeline-failure-breakers';

/**
 * Pure predicate over one `chrome.storage.onChanged` event. Kept separate so
 * the filtering stays unit-testable without a browser event.
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
 * Calls `onChange` whenever a storage event may have left the records list
 * stale. Safe to call outside an extension context (or without a chrome mock):
 * with no `chrome.storage.onChanged` present this is a no-op whose returned
 * unsubscribe is still safe to call.
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
