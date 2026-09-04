// Low-level storage primitives shared by storage.js (records) and
// chatStorage.js (per-article chats). Kept in an internal module so both
// aggregates can serialize their writes on the same global mutation queue
// without an import cycle between them. This module must not import from
// storage.js or chatStorage.js.
//
// The chrome.storage.local plumbing itself lives in the realm-neutral
// src/shared/runtime/localStore.js adapter, which the UI bundles and shared
// settings modules use directly; the re-exports below are the worker-facing
// names for that one implementation.
//
// The aliasing is deliberate rather than transitional. getLocal/setLocal are
// the established vocabulary at ~45 call sites across storage.js,
// chatStorage.js, dataManagement.js, metricsStore.js and llm/providers.js;
// renaming them to match the adapter would churn five modules to delete one
// line here. Import the short names from this module inside worker/, and the
// getLocalItems/... names from the adapter everywhere else.

export {
  getLocalItems as getLocal,
  getLocalItemsByPrefix as getLocalByPrefix,
  getLocalItemsByPrefixes as getLocalByPrefixes,
  getLocalKeysByPrefix,
  setLocalItems as setLocal,
  removeLocalItems as removeLocal,
  clearLocalItems as clearLocal,
} from '../../src/shared/runtime/localStore.js';

/**
 * Per-key promise queue. Serializes all read-modify-write operations on the
 * same record so concurrent pipeline writes cannot clobber each other.
 *
 * Realm-scoped module state ensures every writer shares the same queue; a
 * second coordinator in one realm would reintroduce lost updates.
 * @type {Map<string, Promise<void>>}
 */
const _updateQueues = new Map();
export const MUTATION_QUEUE_KEY = 'pagetollm:mutation-queue';

/**
 * Runs `fn` after all previously-queued work for `key` has settled.
 * A failed prior task does not stall subsequent ones (swallowed internally).
 * The Map entry is pruned once the queue goes idle to avoid a memory leak.
 * @template T
 * @param {string} key - logical record key or INDEX_KEY
 * @param {function(): Promise<T>} fn
 * @returns {Promise<T>}
 */
export function queuedUpdate(key, fn) {
  const prev = _updateQueues.get(key) ?? Promise.resolve();
  const next = prev.then(() => fn());
  const swallowed = next.catch(() => {});
  _updateQueues.set(key, swallowed);
  swallowed.finally(() => {
    if (_updateQueues.get(key) === swallowed) {
      _updateQueues.delete(key);
    }
  });
  return next;
}

/** Clears all per-key queues. Exposed for testing only. */
export function resetUpdateQueues() {
  _updateQueues.clear();
}
