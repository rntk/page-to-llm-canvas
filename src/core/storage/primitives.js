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
 * @param {string} key - internal lock name
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

/**
 * Serializes record mutations in a namespace disjoint from internal locks.
 * Imported keys are arbitrary strings, including internal lock names.
 * @template T
 * @param {string} key Record key.
 * @param {function(): Promise<T>} fn
 * @returns {Promise<T>}
 */
export function queuedRecordUpdate(key, fn) {
  return queuedUpdate(`rec:${key}`, fn);
}

/** Clears all per-key queues. Exposed for testing only. */
export function resetUpdateQueues() {
  _updateQueues.clear();
}
