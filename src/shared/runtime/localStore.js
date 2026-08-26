// Realm-neutral key/value adapter over `chrome.storage.local`.
//
// This is the single place where the extension's storage capability is spelled
// out in terms of the browser API. Worker aggregates reach it through
// worker/storage/primitives.js; UI bundles and the shared settings modules use
// it directly, so neither layer has to import the other's implementation
// directory (and neither has to re-derive the callback/lastError plumbing).
//
// Every accessor reads `chrome.storage.local` lazily at call time rather than
// capturing it at module load, so a test that swaps the global (or a realm
// where the API only appears later) still sees the current object.

/**
 * Builds the rejection Error for a failed `chrome.storage.local` call.
 *
 * Chrome usually populates `lastError.message`, but it is not guaranteed to be
 * a non-empty string; without the fallback a failed call would surface as
 * `Error(undefined)` and lose the only human-readable clue about what broke.
 *
 * @param {string} operation Operation label, e.g. `'storage.set'`.
 * @returns {Error}
 */
function lastErrorAsError(operation) {
  return new Error(chrome.runtime.lastError.message || `${operation} failed`);
}

/**
 * @param {string|string[]|null} keys Key, keys, or null for everything.
 * @returns {Promise<Object>} Resolves with the stored items, rejects with the
 *   `chrome.runtime.lastError` message (see `lastErrorAsError`).
 */
export function getLocalItems(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (items) => {
      if (chrome.runtime?.lastError) {
        reject(lastErrorAsError('storage.get'));
        return;
      }
      resolve(items || {});
    });
  });
}

/**
 * Reads only the keys stored under one namespace when `StorageArea.getKeys` is
 * available (Chrome 130+), avoiding deserialization of unrelated large
 * payloads. Older browsers fall back to one full read filtered locally.
 * @param {string} prefix Storage-key prefix.
 */
export async function getLocalItemsByPrefix(prefix) {
  if (typeof chrome.storage.local.getKeys !== 'function') {
    const allItems = await getLocalItems(null);
    return Object.fromEntries(
      Object.entries(allItems).filter(([storageKey]) => storageKey.startsWith(prefix)),
    );
  }

  const keys = await new Promise((resolve, reject) => {
    chrome.storage.local.getKeys((storedKeys) => {
      if (chrome.runtime?.lastError) {
        reject(lastErrorAsError('storage.getKeys'));
        return;
      }
      resolve(Array.isArray(storedKeys) ? storedKeys : []);
    });
  });
  const matchingKeys = keys.filter((storageKey) => storageKey.startsWith(prefix));
  return matchingKeys.length ? getLocalItems(matchingKeys) : {};
}

/** @param {Object} items @returns {Promise<void>} */
export function setLocalItems(items) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(items, () => {
      if (chrome.runtime?.lastError) {
        reject(lastErrorAsError('storage.set'));
        return;
      }
      resolve();
    });
  });
}

/** @param {string|string[]} keys @returns {Promise<void>} */
export function removeLocalItems(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.remove(keys, () => {
      if (chrome.runtime?.lastError) {
        reject(lastErrorAsError('storage.remove'));
        return;
      }
      resolve();
    });
  });
}

/** @returns {Promise<void>} */
export function clearLocalItems() {
  return new Promise((resolve, reject) => {
    chrome.storage.local.clear(() => {
      if (chrome.runtime?.lastError) {
        reject(lastErrorAsError('storage.clear'));
        return;
      }
      resolve();
    });
  });
}

/**
 * Subscribes to `chrome.storage.local` changes for one key.
 *
 * Centralizes the `areaName === 'local'` filter and the defensive try/catch
 * that every UI subscriber used to repeat inline: outside an extension context
 * (or in a test without a chrome mock) `chrome.storage.onChanged` may be
 * absent, in which case this is a no-op and the returned unsubscribe is still
 * safe to call.
 *
 * @param {string} key Storage key to watch.
 * @param {function(*): void} onValue Called with the key's `newValue`.
 * @returns {function(): void} Unsubscribe.
 */
export function subscribeLocalKey(key, onValue) {
  return subscribeLocalChanges([key], (changes) => onValue(changes[key].newValue));
}

/**
 * Subscribes once to a set of local-storage keys while preserving Chrome's
 * per-event change batch. This is useful when several related preferences must
 * be refreshed atomically from one `storage.onChanged` event.
 *
 * @param {string[]} keys Storage keys to watch.
 * @param {function(Object): void} onChanges Called with the matching Chrome
 *   change records, keyed by storage key.
 * @returns {function(): void} Unsubscribe.
 */
export function subscribeLocalChanges(keys, onChanges) {
  const watchedKeys = new Set(keys);
  const handler = (changes, areaName) => {
    if (areaName !== 'local' || !changes) return;
    const matchingChanges = Object.fromEntries(
      Object.entries(changes).filter(([key]) => watchedKeys.has(key)),
    );
    if (Object.keys(matchingChanges).length > 0) onChanges(matchingChanges);
  };

  try {
    chrome.storage.onChanged.addListener(handler);
  } catch (_) {
    return () => {};
  }

  return () => {
    try {
      chrome.storage.onChanged.removeListener(handler);
    } catch (_) {
      /* noop */
    }
  };
}

/**
 * Chrome-backed store capability for browser composition roots.
 *
 * Deliberately narrower than this module's export list: it carries only the
 * reads and subscriptions that injected consumers actually take. Writers
 * (settings modules, worker aggregates) import the functions above directly,
 * so mirroring them here would only widen what an injected consumer appears to
 * need. Add a member when a consumer needs it, not before.
 */
export const browserLocalStore = Object.freeze({
  get: getLocalItems,
  subscribe: subscribeLocalKey,
  subscribeChanges: subscribeLocalChanges,
});

/**
 * Builds the read/write pair for one small persisted setting.
 *
 * Every setting in this extension wants the same asymmetric error contract,
 * which used to be hand-rolled once per setting module: a read degrades to the
 * normalized default rather than throwing (so a storage hiccup never breaks the
 * pipeline), while a write rejects so the UI can roll its optimistic update
 * back.
 *
 * @template T
 * @param {{key: string, defaultValue: T, normalize: function(*): T}} options
 * @returns {{read: function(): Promise<T>, write: function(*): Promise<T>}}
 */
export function createStoredSetting({ key, defaultValue, normalize }) {
  return {
    read() {
      return Promise.resolve()
        .then(() => getLocalItems(key))
        .then((items) => normalize(items ? items[key] : undefined))
        .catch(() => defaultValue);
    },

    write(value) {
      const normalized = normalize(value);
      return Promise.resolve()
        .then(() => setLocalItems({ [key]: normalized }))
        .then(() => normalized)
        .catch((err) => {
          // A non-Error throw from a missing/hostile storage API still reaches
          // callers as an Error, which is what the UI rollback paths expect.
          throw err instanceof Error ? err : new Error(String(err));
        });
    },
  };
}

/**
 * Parses a stored value into an integer inside `[min, max]`, falling back to
 * `fallback` when it is not a finite number. Shared by the numeric settings
 * built on `createStoredSetting` so the parse/clamp semantics (truncate, then
 * clamp, never throw) stay identical across them.
 *
 * @param {unknown} value Raw stored or user-supplied value.
 * @param {{min: number, max: number, fallback: number}} bounds
 * @returns {number}
 */
export function normalizeClampedInt(value, { min, max, fallback }) {
  const parsed = typeof value === 'number' ? Math.trunc(value) : Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
