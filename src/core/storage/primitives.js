// Shared storage primitives and mutation queue for records and chats, avoiding
// an import cycle. Worker-facing aliases use the browser adapter in
// shared/runtime/localStore.js.

export {
  getLocalItems as getLocal,
  getLocalItemsByPrefix as getLocalByPrefix,
  getLocalItemsByPrefixes as getLocalByPrefixes,
  getLocalKeysByPrefix,
  getAllLocalKeys,
  setLocalItems as setLocal,
  removeLocalItems as removeLocal,
  clearLocalItems as clearLocal,
} from '../../shared/runtime/localStore.js';

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
