// Shared chrome.storage.local adapter. Each call reads the current browser API,
// allowing tests or late API initialization to replace it.

/**
 * Builds an Error with an operation fallback when lastError has no message.
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
 * Reads one namespace without deserializing unrelated values when getKeys is
 * available; older browsers fall back to a full read.
 * @param {string} prefix Storage-key prefix.
 */
export async function getLocalItemsByPrefix(prefix) {
  return getLocalItemsByPrefixes([prefix]);
}

/**
 * Reads supplied namespaces with one key inventory pass.
 * @param {string[]} prefixes
 */
export async function getLocalItemsByPrefixes(prefixes) {
  const matchingKeys = await getLocalKeysByPrefixes(prefixes);
  return matchingKeys.length ? getLocalItems(matchingKeys) : {};
}

/**
 * Uses getKeys' returned promise when it provides one, else its callback form.
 * Callers check that getKeys exists first.
 * @returns {Promise<string[]>}
 */
function readAllLocalKeys() {
  const asKeyArray = (storedKeys) => (Array.isArray(storedKeys) ? storedKeys : []);
  let pending;
  try {
    pending = chrome.storage.local.getKeys();
  } catch {
    pending = undefined;
  }
  if (pending && typeof pending.then === 'function') {
    return Promise.resolve(pending).then(asKeyArray);
  }
  return new Promise((resolve, reject) => {
    chrome.storage.local.getKeys((storedKeys) => {
      if (chrome.runtime?.lastError) {
        reject(lastErrorAsError('storage.getKeys'));
        return;
      }
      resolve(asKeyArray(storedKeys));
    });
  });
}

/**
 * Lists every stored key without deserializing any value when
 * `StorageArea.getKeys` is available (Chrome 130+). Older browsers expose no
 * keys-only API, so they fall back to one full read whose values are dropped
 * as soon as the key list has been taken.
 * @returns {Promise<string[]>}
 */
export async function getAllLocalKeys() {
  if (typeof chrome.storage.local.getKeys !== 'function') {
    return Object.keys(await getLocalItems(null));
  }
  return readAllLocalKeys();
}

/**
 * Lists keys under one namespace without deserializing their values when
 * `StorageArea.getKeys` is available. Older browsers fall back to one full
 * read because they expose no keys-only API.
 * @param {string} prefix Storage-key prefix.
 * @returns {Promise<string[]>}
 */
export async function getLocalKeysByPrefix(prefix) {
  return getLocalKeysByPrefixes([prefix]);
}

/**
 * Lists keys belonging to any supplied namespace.
 * @param {string[]} prefixes
 * @returns {Promise<string[]>}
 */
export async function getLocalKeysByPrefixes(prefixes) {
  const wanted = Array.isArray(prefixes)
    ? prefixes.filter((prefix) => typeof prefix === 'string')
    : [];
  if (wanted.length === 0) return [];
  const keys = await getAllLocalKeys();
  return keys.filter((storageKey) => wanted.some((prefix) => storageKey.startsWith(prefix)));
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
 * Subscribes to `chrome.storage.local` changes for one key. No-op when
 * `chrome.storage.onChanged` is unavailable (no extension context, or tests);
 * the returned unsubscribe is still safe to call.
 *
 * @param {string} key Storage key to watch.
 * @param {function(*): void} onValue Called with the key's `newValue`.
 * @returns {function(): void} Unsubscribe.
 */
export function subscribeLocalKey(key, onValue) {
  return subscribeLocalChanges([key], (changes) => onValue(changes[key].newValue));
}

/**
 * Subscribes to several local-storage keys, keeping Chrome's per-event change
 * batch so related preferences refresh atomically.
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
 * Browser-backed read/subscribe capability for injection. Intentionally narrower
 * than this module's exports; add a member only when a consumer needs it.
 */
export const browserLocalStore = Object.freeze({
  get: getLocalItems,
  subscribe: subscribeLocalKey,
  subscribeChanges: subscribeLocalChanges,
});

/**
 * Read/write pair for one persisted setting. Reads fall back to the default so a
 * storage error never breaks the pipeline; writes reject so the UI can roll back.
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
 * Parses a value to an integer clamped to `[min, max]` (truncate, then clamp;
 * never throws). Falls back when the value is not a finite number.
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
