export const INDEX_KEY = 'pagetollm:index';
const MAX_PROCESSING_LOG_ENTRIES = 80;
const RECORD_SNIPPET_MAX_CHARS = 500;

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

/** Clears all per-key queues and buffered log state. Exposed for testing only. */
export function _resetUpdateQueues() {
  _updateQueues.clear();
  for (const timer of _logFlushTimers.values()) clearTimeout(timer);
  _logFlushTimers.clear();
  _logBuffers.clear();
}

async function readIndex() {
  const items = await getLocal(INDEX_KEY);
  const idx = items[INDEX_KEY];
  if (idx && Array.isArray(idx.keys)) {
    return { keys: idx.keys, meta: idx.meta && typeof idx.meta === 'object' ? idx.meta : {} };
  }
  return { keys: [], meta: {} };
}

async function writeIndex(idx) {
  await setLocal({ [INDEX_KEY]: idx });
}

/**
 * The lightweight projection of a record cached in the index (`meta`) and
 * returned by `listRecords`. Kept separate from the full record so that
 * frequent metadata-only changes (status/progress ticks) never require
 * reading or writing every record's full payload (html/text/sentences/
 * topics/summaries) just to keep listings up to date.
 */
function buildRecordMeta(rec) {
  return {
    sourceUrl: rec.sourceUrl,
    snippet: buildRecordSnippet(rec),
    createdAt: rec.createdAt,
    status: rec.status,
    progress: rec.progress,
    error: rec.error,
  };
}

const INDEX_META_FIELDS = ['status', 'progress', 'error', 'text', 'sourceUrl'];

/**
 * Best-effort refresh of a record's cached index projection. Skipped entirely
 * when `patch` touches none of the fields the projection exposes, so the
 * (much more frequent) processingLog-only writes never touch the index.
 * A failure here only makes the cached listing momentarily stale — it never
 * threatens the record write that already succeeded — so it is swallowed.
 */
async function syncIndexMeta(key, patch, merged) {
  if (!INDEX_META_FIELDS.some((f) => Object.prototype.hasOwnProperty.call(patch, f))) return;
  try {
    await queuedUpdate(INDEX_KEY, async () => {
      const idx = await readIndex();
      if (!idx.keys.includes(key)) return; // record was deleted concurrently
      idx.meta[key] = buildRecordMeta(merged);
      await writeIndex(idx);
    });
  } catch (err) {
    console.warn('PageToLLM Canvas: failed to sync index meta for', key, err);
  }
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
          idx.meta[rec.key] = buildRecordMeta(rec);
          await writeIndex(idx);
        });
      } catch (err) {
        await removeLocal(sKey).catch(() => {});
        throw err;
      }
    });
  });
}

export async function updateRecord(key, patch, options = {}) {
  return queuedUpdate(MUTATION_QUEUE_KEY, () => {
    return queuedUpdate(key, async () => {
      const current = await readRecord(key);
      if (!current) return null;
      if (
        Object.prototype.hasOwnProperty.call(options, 'expectedPipelineRunId') &&
        current.pipelineRunId !== options.expectedPipelineRunId
      ) {
        return null;
      }
      const merged = { ...current, ...patch, updatedAt: Date.now() };
      const sKey = recordStorageKey(key);
      await setLocal({ [sKey]: merged });
      await syncIndexMeta(key, patch, merged);
      return merged;
    });
  });
}

// Pipeline stages fire a processingLog entry on nearly every LLM request and
// response (see orchestrator.js logPipeline), which used to mean one full
// read-modify-write of the record per entry. Entries are instead buffered in
// memory per record key and flushed as a single write once the buffer has
// been quiet for LOG_FLUSH_DELAY_MS (bounded from the first buffered entry,
// not reset per entry, so a sustained burst still flushes periodically).
const LOG_FLUSH_DELAY_MS = 250;
/** @type {Map<string, {entries: object[], options: object, deferred: {promise: Promise, resolve: Function, reject: Function}}>} */
const _logBuffers = new Map();
/** @type {Map<string, ReturnType<typeof setTimeout>>} */
const _logFlushTimers = new Map();

function createDeferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function doFlushProcessingLog(key) {
  const buf = _logBuffers.get(key);
  if (!buf) return;
  _logBuffers.delete(key);
  const { entries, options, deferred } = buf;
  try {
    const result = await queuedUpdate(MUTATION_QUEUE_KEY, () =>
      queuedUpdate(key, async () => {
        const current = await readRecord(key);
        if (!current) return null;
        if (
          Object.prototype.hasOwnProperty.call(options, 'expectedPipelineRunId') &&
          current.pipelineRunId !== options.expectedPipelineRunId
        ) {
          return null;
        }
        const existing = Array.isArray(current.processingLog) ? current.processingLog : [];
        const processingLog = [...existing, ...entries].slice(-MAX_PROCESSING_LOG_ENTRIES);
        const merged = { ...current, processingLog, updatedAt: Date.now() };
        await setLocal({ [recordStorageKey(key)]: merged });
        return merged;
      }),
    );
    deferred.resolve(result);
  } catch (err) {
    deferred.reject(err);
  }
}

/**
 * Forces any buffered log entries for `key` to flush immediately, bypassing
 * the debounce timer. Called at pipeline run exit so the final batch of
 * diagnostic entries isn't left stranded if the service worker is recycled
 * shortly after.
 * @param {string} key
 * @returns {Promise<object | null>}
 */
export function flushProcessingLog(key) {
  const timer = _logFlushTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    _logFlushTimers.delete(key);
  }
  if (!_logBuffers.has(key)) return Promise.resolve(null);
  return doFlushProcessingLog(key);
}

/**
 * @param {string} key
 * @param {string} stage
 * @param {Record<string, unknown>} [details]
 * @returns {Promise<object | null>}
 */
export function appendProcessingLog(key, stage, details = {}, options = {}) {
  const entry = { at: new Date().toISOString(), stage, details };
  const stale = _logBuffers.get(key);
  if (stale && stale.options.expectedPipelineRunId !== options.expectedPipelineRunId) {
    // A new pipeline run (retry/reprocess) started for this record before the
    // previous run's buffered entries flushed. Flush the stale buffer now,
    // under its own run id, instead of letting its entries ride along on this
    // call's options — otherwise they'd bypass the stale-run guard in
    // doFlushProcessingLog and get written in under the new run's identity.
    flushProcessingLog(key);
  }
  let buf = _logBuffers.get(key);
  if (!buf) {
    buf = { entries: [], options, deferred: createDeferred() };
    _logBuffers.set(key, buf);
  }
  buf.entries.push(entry);
  buf.options = options;
  if (!_logFlushTimers.has(key)) {
    const timer = setTimeout(() => {
      _logFlushTimers.delete(key);
      doFlushProcessingLog(key);
    }, LOG_FLUSH_DELAY_MS);
    _logFlushTimers.set(key, timer);
  }
  return buf.deferred.promise;
}

export async function listRecords() {
  const idx = await readIndex();
  if (!idx.keys.length) return [];
  // Steady state: every key already has a cached projection (kept in sync by
  // writeRecord/updateRecord), so this never touches the full records.
  // Records written before this cache existed fall back to a one-time full
  // read that backfills the cache for next time.
  const missingKeys = idx.keys.filter((k) => !idx.meta[k]);
  if (missingKeys.length) {
    const items = await getLocal(missingKeys.map(recordStorageKey));
    const backfilled = {};
    for (const k of missingKeys) {
      const rec = items[recordStorageKey(k)];
      if (rec) backfilled[k] = buildRecordMeta(rec);
    }
    if (Object.keys(backfilled).length) {
      await queuedUpdate(INDEX_KEY, async () => {
        const freshIdx = await readIndex();
        freshIdx.meta = { ...freshIdx.meta, ...backfilled };
        await writeIndex(freshIdx);
      }).catch(() => {});
      Object.assign(idx.meta, backfilled);
    }
  }
  const out = [];
  for (const k of idx.keys) {
    const meta = idx.meta[k];
    if (meta) out.push({ key: k, ...meta });
  }
  return out;
}

export function buildRecordSnippet(record) {
  const text = String((record && record.text) || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= RECORD_SNIPPET_MAX_CHARS) return text;
  return `${text.slice(0, RECORD_SNIPPET_MAX_CHARS).trimEnd()}...`;
}

export async function deleteRecord(key) {
  return queuedUpdate(MUTATION_QUEUE_KEY, () => {
    return queuedUpdate(key, () => {
      return queuedUpdate(INDEX_KEY, async () => {
        const idx = await readIndex();
        const nextMeta = { ...idx.meta };
        delete nextMeta[key];
        const nextIdx = { keys: idx.keys.filter((k) => k !== key), meta: nextMeta };
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
