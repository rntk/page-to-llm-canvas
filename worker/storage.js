export const INDEX_KEY = 'pagetollm:index';
const MAX_PROCESSING_LOG_ENTRIES = 80;

export function recordStorageKey(key) {
  return `pagetollm:rec:${key}`;
}

async function getLocal(keys) {
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

async function setLocal(items) {
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

async function removeLocal(keys) {
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

/**
 * Per-key promise queue. Serializes all read-modify-write operations on the
 * same record so concurrent pipeline writes cannot clobber each other.
 * @type {Map<string, Promise<void>>}
 */
const _updateQueues = new Map();
const MUTATION_QUEUE_KEY = 'pagetollm:mutation-queue';

/**
 * Runs `fn` after all previously-queued work for `key` has settled.
 * A failed prior task does not stall subsequent ones (swallowed internally).
 * The Map entry is pruned once the queue goes idle to avoid a memory leak.
 * @template T
 * @param {string} key - logical record key or INDEX_KEY
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function queuedUpdate(key, fn) {
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
export function _resetUpdateQueues() {
  _updateQueues.clear();
}

async function readIndex() {
  const items = await getLocal(INDEX_KEY);
  const idx = items[INDEX_KEY];
  if (idx && Array.isArray(idx.keys)) return idx;
  return { keys: [] };
}

async function writeIndex(idx) {
  await setLocal({ [INDEX_KEY]: idx });
}

export async function readRecord(key) {
  const sKey = recordStorageKey(key);
  const items = await getLocal(sKey);
  return items[sKey] || null;
}

export async function writeRecord(rec) {
  if (!rec || !rec.key) throw new Error('writeRecord: record.key required');
  return queuedUpdate(MUTATION_QUEUE_KEY, () => {
    return queuedUpdate(rec.key, async () => {
      const sKey = recordStorageKey(rec.key);
      await setLocal({ [sKey]: rec });

      try {
        await queuedUpdate(INDEX_KEY, async () => {
          const idx = await readIndex();
          const existing = idx.keys.indexOf(rec.key);
          if (existing !== -1) idx.keys.splice(existing, 1);
          idx.keys.unshift(rec.key);
          await writeIndex(idx);
        });
      } catch (err) {
        await removeLocal(sKey).catch(() => {});
        throw err;
      }
    });
  });
}

export async function updateRecord(key, patch) {
  return queuedUpdate(MUTATION_QUEUE_KEY, () => {
    return queuedUpdate(key, async () => {
      const current = await readRecord(key);
      if (!current) return null;
      const merged = { ...current, ...patch, updatedAt: Date.now() };
      const sKey = recordStorageKey(key);
      await setLocal({ [sKey]: merged });
      return merged;
    });
  });
}

/**
 * @param {string} key
 * @param {string} stage
 * @param {Record<string, unknown>} [details]
 * @returns {Promise<object | null>}
 */
export async function appendProcessingLog(key, stage, details = {}) {
  return queuedUpdate(MUTATION_QUEUE_KEY, () => {
    return queuedUpdate(key, async () => {
      const current = await readRecord(key);
      if (!current) return null;
      const entry = {
        at: new Date().toISOString(),
        stage,
        details,
      };
      const existing = Array.isArray(current.processingLog) ? current.processingLog : [];
      const processingLog = [...existing, entry].slice(-MAX_PROCESSING_LOG_ENTRIES);
      const merged = { ...current, processingLog, updatedAt: Date.now() };
      await setLocal({ [recordStorageKey(key)]: merged });
      return merged;
    });
  });
}

export async function listRecords() {
  const idx = await readIndex();
  if (!idx.keys.length) return [];
  const sKeys = idx.keys.map(recordStorageKey);
  const items = await getLocal(sKeys);
  const out = [];
  for (const k of idx.keys) {
    const rec = items[recordStorageKey(k)];
    if (rec) {
      out.push({
        key: rec.key,
        sourceUrl: rec.sourceUrl,
        createdAt: rec.createdAt,
        status: rec.status,
        progress: rec.progress,
      });
    }
  }
  return out;
}

export async function deleteRecord(key) {
  return queuedUpdate(MUTATION_QUEUE_KEY, () => {
    return queuedUpdate(key, () => {
      return queuedUpdate(INDEX_KEY, async () => {
        const idx = await readIndex();
        const nextIdx = { ...idx, keys: idx.keys.filter((k) => k !== key) };
        await writeIndex(nextIdx);
        try {
          await removeLocal(recordStorageKey(key));
        } catch (err) {
          await writeIndex(idx).catch(() => {});
          throw err;
        }
      });
    });
  });
}

export async function deleteAll() {
  return queuedUpdate(MUTATION_QUEUE_KEY, () => {
    return queuedUpdate(INDEX_KEY, async () => {
      const idx = await readIndex();
      const sKeys = idx.keys.map(recordStorageKey);
      if (sKeys.length) await removeLocal(sKeys);
      await removeLocal(INDEX_KEY);
    });
  });
}

/**
 * Finds a record in storage by its source URL.
 * @param {string} url - The URL of the source page to match.
 * @returns {Promise<object | null>} The matching record, or null if not found.
 */
export async function findRecordByUrl(url) {
  if (!url) return null;
  const idx = await readIndex();
  if (!idx.keys.length) return null;
  const sKeys = idx.keys.map(recordStorageKey);
  const items = await getLocal(sKeys);
  for (const k of idx.keys) {
    const rec = items[recordStorageKey(k)];
    if (rec && rec.sourceUrl === url) {
      return rec;
    }
  }
  return null;
}
