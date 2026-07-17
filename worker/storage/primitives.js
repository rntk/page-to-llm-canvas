// Low-level storage primitives shared by storage.js (records) and
// chatStorage.js (per-article chats). Kept in a dependency-free internal module
// so both aggregates can serialize their writes on the same global mutation
// queue without an import cycle between them. This module must not import from
// storage.js or chatStorage.js.

export async function getLocal(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (items) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(items || {});
    });
  });
}

/** Reads only keys under one namespace when StorageArea.getKeys is available
 * (Chrome 130+), avoiding deserialization of unrelated large record payloads.
 * Older browsers fall back to one full read and filter the result locally. */
export async function getLocalByPrefix(prefix) {
  if (typeof chrome.storage.local.getKeys !== 'function') {
    const allItems = await getLocal(null);
    return Object.fromEntries(
      Object.entries(allItems).filter(([storageKey]) => storageKey.startsWith(prefix)),
    );
  }

  const keys = await new Promise((resolve, reject) => {
    chrome.storage.local.getKeys((storedKeys) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(Array.isArray(storedKeys) ? storedKeys : []);
    });
  });
  const matchingKeys = keys.filter((storageKey) => storageKey.startsWith(prefix));
  return matchingKeys.length ? getLocal(matchingKeys) : {};
}

export async function setLocal(items) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(items, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

export async function removeLocal(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.remove(keys, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

/** Removes every value owned by the extension's local storage area. */
export async function clearLocal() {
  return new Promise((resolve, reject) => {
    chrome.storage.local.clear(() => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

/**
 * Per-key promise queue. Serializes all read-modify-write operations on the
 * same record so concurrent pipeline writes cannot clobber each other.
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
 * @param {() => Promise<T>} fn
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
