import {
  getLocal,
  getLocalByPrefix,
  setLocal,
  removeLocal,
  queuedUpdate,
  MUTATION_QUEUE_KEY,
  resetUpdateQueues,
} from './primitives.js';
import {
  allChatStorageKeys,
  chatStorageKeysForRecord,
  pruneChatsForContentRevision,
} from './chatStorage.js';
import {
  recordMetaStorageKey as metaStorageKey,
  recordContentStorageKey as contentStorageKey,
  recordSummariesStorageKey as summariesStorageKey,
} from './keys.js';

export const INDEX_KEY = 'pagetollm:index';
// Version stamp for the cached index projections (see buildRecordMeta). Bump it
// whenever a field is added to the projection, and teach migrateIndexMeta to
// backfill that field, so records written by an older version still expose it
// to listRecords without ever reading full records on the listing path.
export const INDEX_SCHEMA_KEY = 'pagetollm:index-schema';
export const INDEX_SCHEMA_VERSION = 1;
const MAX_PROCESSING_LOG_ENTRIES = 80;
const RECORD_SNIPPET_MAX_CHARS = 500;
export const RECORD_STORAGE_PREFIX = 'pagetollm:rec:';

// A record is physically split across three storage keys so that the
// high-frequency writes (status/progress/log ticks) never have to
// re-serialize the large, rarely-changing payload (html/text/sentences/
// topics) or the moderately-changing per-topic summaries:
//   - meta: everything else — the hot path, written on nearly every pipeline
//     step.
//   - content: html/text/sentences/topics — written a handful of times per
//     run (essentially write-once).
//   - summaries: topic_summaries/topic_summary_index — written once per
//     completed topic.
const CONTENT_FIELDS = ['html', 'text', 'sentences', 'topics'];
const SUMMARY_FIELDS = ['topic_summaries', 'topic_summary_index'];

function hasOwn(obj, field) {
  return Object.prototype.hasOwnProperty.call(obj, field);
}

function pickFields(obj, fields) {
  const out = {};
  for (const f of fields) {
    if (hasOwn(obj, f)) out[f] = obj[f];
  }
  return out;
}

function pickContentFields(obj) {
  return pickFields(obj, CONTENT_FIELDS);
}

function pickSummaryFields(obj) {
  return pickFields(obj, SUMMARY_FIELDS);
}

/** Everything that isn't explicitly content or summaries lives in meta. */
function pickMetaFields(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!CONTENT_FIELDS.includes(k) && !SUMMARY_FIELDS.includes(k)) out[k] = v;
  }
  return out;
}

/** Clears all per-key queues and buffered log state. Exposed for testing only. */
export function _resetUpdateQueues() {
  resetUpdateQueues();
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
    // Outcome flag ("finished intentionally without summaries"), not the run
    // directive — listings use it to offer summary generation for the record.
    summariesDisabled: rec.summariesDisabled === true,
  };
}

const INDEX_META_FIELDS = ['status', 'progress', 'error', 'text', 'sourceUrl', 'summariesDisabled'];

/**
 * Best-effort, incremental refresh of a record's cached index projection.
 * Only reads/writes the small `patch` fields the projection cares about (plus
 * whatever was already cached) — never the full record — so a status/progress
 * tick never has to pull in the (possibly large) content doc just to keep the
 * snippet around. The snippet itself is only recomputed when `patch.text` is
 * actually present (i.e. when the content doc changes), not on every sync.
 * Skipped entirely when `patch` touches none of the fields the projection
 * exposes, so the (much more frequent) processingLog-only writes never touch
 * the index. A failure here only makes the cached listing momentarily stale —
 * it never threatens the record write that already succeeded — so it is
 * swallowed.
 */
async function syncIndexMeta(key, patch, fallbackMeta) {
  if (!INDEX_META_FIELDS.some((f) => hasOwn(patch, f))) return;
  try {
    await queuedUpdate(INDEX_KEY, async () => {
      const idx = await readIndex();
      if (!idx.keys.includes(key)) return; // record was deleted concurrently
      const prev = idx.meta[key] || {};
      const next = { ...prev };
      if (hasOwn(patch, 'status')) next.status = patch.status;
      if (hasOwn(patch, 'progress')) next.progress = patch.progress;
      if (hasOwn(patch, 'error')) next.error = patch.error;
      if (hasOwn(patch, 'sourceUrl')) next.sourceUrl = patch.sourceUrl;
      if (hasOwn(patch, 'summariesDisabled'))
        next.summariesDisabled = patch.summariesDisabled === true;
      if (hasOwn(patch, 'text')) next.snippet = buildRecordSnippet({ text: patch.text });
      if (next.createdAt === undefined) next.createdAt = fallbackMeta && fallbackMeta.createdAt;
      idx.meta[key] = next;
      await writeIndex(idx);
    });
  } catch (err) {
    console.warn('PageToLLM Canvas: failed to sync index meta for', key, err);
  }
}

/**
 * One-time backfill of index projections written by an older extension version,
 * so fields added to buildRecordMeta later (currently: `summariesDisabled`)
 * appear in listRecords for pre-existing records too. Reads only the small meta
 * docs of the entries actually missing a field, then stamps a non-empty
 * repository with INDEX_SCHEMA_KEY so subsequent startups are a single storage
 * read. Runs at service-worker startup (background.js) rather than lazily in
 * listRecords, which must stay write-free:
 * it is invoked from the storage.onChanged listener, and a repair write there
 * would re-trigger it.
 *
 * Failures are swallowed (a stale projection only hides per-record actions in
 * listings); the schema stamp is written last, so a failed attempt retries on
 * the next startup.
 *
 * @returns {Promise<void>}
 */
export async function migrateIndexMeta() {
  try {
    const stamped = (await getLocal(INDEX_SCHEMA_KEY))[INDEX_SCHEMA_KEY];
    if (stamped === INDEX_SCHEMA_VERSION) return;
    let hasRecords = false;
    await queuedUpdate(INDEX_KEY, async () => {
      const idx = await readIndex();
      hasRecords = idx.keys.length > 0;
      const missing = idx.keys.filter(
        (k) => idx.meta[k] && !hasOwn(idx.meta[k], 'summariesDisabled'),
      );
      if (missing.length) {
        const metas = await getLocal(missing.map(metaStorageKey));
        for (const k of missing) {
          const meta = metas[metaStorageKey(k)];
          idx.meta[k].summariesDisabled = !!meta && meta.summariesDisabled === true;
        }
        await writeIndex(idx);
      }
    });
    // An empty repository needs no migration stamp. Avoid recreating storage
    // merely because the worker restarted after the user deleted everything.
    if (hasRecords) await setLocal({ [INDEX_SCHEMA_KEY]: INDEX_SCHEMA_VERSION });
  } catch (err) {
    console.warn('PageToLLM Canvas: index meta migration failed:', err);
  }
}

/**
 * Reads and reassembles the full logical record from its three physical docs.
 * Returns `null` if none of them hold anything.
 */
export async function readRecord(key) {
  const metaKey = metaStorageKey(key);
  const contentKey = contentStorageKey(key);
  const summariesKey = summariesStorageKey(key);
  const items = await getLocal([metaKey, contentKey, summariesKey]);
  const meta = items[metaKey];
  const content = items[contentKey];
  const summaries = items[summariesKey];
  if (!meta && !content && !summaries) return null;
  return { ...(content || {}), ...(summaries || {}), ...(meta || {}) };
}

export async function writeRecord(rec, options = {}) {
  if (!rec || !rec.key) throw new Error('writeRecord: record.key required');
  return queuedUpdate(MUTATION_QUEUE_KEY, () => {
    return queuedUpdate(rec.key, async () => {
      const metaKey = metaStorageKey(rec.key);
      const contentKey = contentStorageKey(rec.key);
      const summariesKey = summariesStorageKey(rec.key);
      const existingMeta = await loadMetaForWrite(rec.key);
      const contentRevision =
        options.bumpContentRevision === true
          ? createContentRevision()
          : typeof rec.contentRevision === 'string' && rec.contentRevision
            ? rec.contentRevision
            : existingMeta?.contentRevision || createContentRevision();
      await setLocal({
        [metaKey]: { ...pickMetaFields(rec), contentRevision },
        [contentKey]: pickContentFields(rec),
        [summariesKey]: pickSummaryFields(rec),
      });

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
        await removeLocal([metaKey, contentKey, summariesKey]).catch(() => {});
        throw err;
      }
      if (existingMeta && options.bumpContentRevision === true) {
        await pruneChatsForContentRevision(rec.key, contentRevision).catch((err) => {
          console.warn('PageToLLM Canvas: stale chat cleanup failed:', err);
        });
      }
    });
  });
}

/**
 * Loads a record's meta doc for a write path (updateRecord / log flush).
 * Only reads the small meta doc — the whole point of the split, since this
 * runs on nearly every pipeline step. Returns `null` if the record does not
 * exist.
 */
async function loadMetaForWrite(key) {
  const metaKey = metaStorageKey(key);
  const items = await getLocal(metaKey);
  return items[metaKey] || null;
}

function createContentRevision() {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid
    ? `rev_${uuid}`
    : `rev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

function isStaleRun(meta, options) {
  return (
    hasOwn(options, 'expectedPipelineRunId') && meta.pipelineRunId !== options.expectedPipelineRunId
  );
}

export async function updateRecord(key, patch, options = {}) {
  return queuedUpdate(MUTATION_QUEUE_KEY, () => {
    return queuedUpdate(key, async () => {
      const meta = await loadMetaForWrite(key);
      if (!meta) return null;
      if (isStaleRun(meta, options)) return null;

      const touchesContent = CONTENT_FIELDS.some((f) => hasOwn(patch, f));
      const touchesSummaries = SUMMARY_FIELDS.some((f) => hasOwn(patch, f));

      const writes = {};
      let mergedContent;
      let mergedSummaries;

      if (touchesContent) {
        const contentKey = contentStorageKey(key);
        const currentContent = (await getLocal(contentKey))[contentKey] || {};
        mergedContent = { ...currentContent, ...pickContentFields(patch) };
        writes[contentKey] = mergedContent;
      }
      if (touchesSummaries) {
        const summariesKey = summariesStorageKey(key);
        const currentSummaries = (await getLocal(summariesKey))[summariesKey] || {};
        mergedSummaries = { ...currentSummaries, ...pickSummaryFields(patch) };
        writes[summariesKey] = mergedSummaries;
      }

      const mergedMeta = { ...meta, ...pickMetaFields(patch), updatedAt: Date.now() };
      if (touchesContent && options.bumpContentRevision === true) {
        mergedMeta.contentRevision = createContentRevision();
      }
      writes[metaStorageKey(key)] = mergedMeta;

      await setLocal(writes);
      await syncIndexMeta(key, patch, mergedMeta);
      if (touchesContent && options.bumpContentRevision === true) {
        await pruneChatsForContentRevision(key, mergedMeta.contentRevision).catch((err) => {
          console.warn('PageToLLM Canvas: stale chat cleanup failed:', err);
        });
      }

      return { ...mergedMeta, ...(mergedContent || {}), ...(mergedSummaries || {}) };
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
        // processingLog lives in the meta doc, so a flush — the hottest write
        // path in the pipeline — only ever touches the small meta doc.
        const meta = await loadMetaForWrite(key);
        if (!meta) return null;
        if (isStaleRun(meta, options)) return null;

        const existing = Array.isArray(meta.processingLog) ? meta.processingLog : [];
        const processingLog = [...existing, ...entries].slice(-MAX_PROCESSING_LOG_ENTRIES);
        const mergedMeta = { ...meta, processingLog, updatedAt: Date.now() };

        await setLocal({ [metaStorageKey(key)]: mergedMeta });
        return mergedMeta;
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
 * @param {{expectedPipelineRunId?: unknown}} [options]  Identifies the pipeline
 *   run this entry belongs to; a buffer whose entries were queued under a
 *   different run id is treated as stale and flushed before this entry starts
 *   a new buffer under `options`.
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
    void flushProcessingLog(key);
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
      void doFlushProcessingLog(key);
    }, LOG_FLUSH_DELAY_MS);
    _logFlushTimers.set(key, timer);
  }
  return buf.deferred.promise;
}

export async function listRecords() {
  const idx = await readIndex();
  // Every key's projection is kept in sync by writeRecord/updateRecord, so
  // this never touches the full records.
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

/** Returns all physical page-record documents, including unindexed orphans. */
export async function allRecordStorageKeys() {
  return Object.keys(await getLocalByPrefix(RECORD_STORAGE_PREFIX));
}

export async function deleteRecord(key) {
  return queuedUpdate(MUTATION_QUEUE_KEY, () => {
    return queuedUpdate(key, () => {
      return queuedUpdate(INDEX_KEY, async () => {
        const idx = await readIndex();
        const nextMeta = { ...idx.meta };
        delete nextMeta[key];
        const nextIdx = { keys: idx.keys.filter((k) => k !== key), meta: nextMeta };
        // Gather all keys before mutating anything. One remove call makes the
        // cascade atomic from this repository's perspective: a failure cannot
        // leave an indexed record whose documents were already removed.
        const keys = [
          metaStorageKey(key),
          contentStorageKey(key),
          summariesStorageKey(key),
          ...(await chatStorageKeysForRecord(key)),
        ];
        await removeLocal([...new Set(keys)]);
        try {
          await writeIndex(nextIdx);
        } catch (err) {
          // Documents are gone but retaining an index entry would create a
          // ghost record. Best-effort removal keeps listings authoritative.
          await writeIndex(nextIdx).catch(() => {});
          throw err;
        }
      });
    });
  });
}

export async function deleteAll() {
  return queuedUpdate(MUTATION_QUEUE_KEY, () => {
    return queuedUpdate(INDEX_KEY, async () => {
      // Neither index is a source of truth for cleanup: an interrupted write
      // can leave a page or chat document that no index names. Scan both owned
      // namespaces first, then remove everything in one call so hidden orphan
      // data is covered by the same user-facing action as visible records.
      const keys = [
        ...(await allRecordStorageKeys()),
        ...(await allChatStorageKeys()),
        INDEX_KEY,
        INDEX_SCHEMA_KEY,
      ];
      await removeLocal([...new Set(keys)]);
    });
  });
}

function recordKeyFromStorageDocument(storageKey, suffix) {
  if (!storageKey.startsWith(RECORD_STORAGE_PREFIX) || !storageKey.endsWith(suffix)) return null;
  const key = storageKey.slice(RECORD_STORAGE_PREFIX.length, -suffix.length);
  return key || null;
}

/**
 * Repairs page records after interrupted multi-key writes. Meta documents are
 * authoritative: a meta document missing from the index is made visible again
 * so the user can inspect/delete it, ghost index entries are removed, and
 * content/summary documents without an owning meta document are deleted.
 */
export async function reconcileRecordStorage() {
  return queuedUpdate(MUTATION_QUEUE_KEY, () =>
    queuedUpdate(INDEX_KEY, async () => {
      const documents = await getLocalByPrefix(RECORD_STORAGE_PREFIX);
      const groups = new Map();
      const invalidKeys = [];

      const groupFor = (key) => {
        let group = groups.get(key);
        if (!group) {
          group = {};
          groups.set(key, group);
        }
        return group;
      };

      for (const [storageKey, value] of Object.entries(documents)) {
        const metaKey = recordKeyFromStorageDocument(storageKey, ':meta');
        if (metaKey && metaStorageKey(metaKey) === storageKey) {
          groupFor(metaKey).meta = value;
          groupFor(metaKey).metaStorageKey = storageKey;
          continue;
        }
        const contentKey = recordKeyFromStorageDocument(storageKey, ':content');
        if (contentKey && contentStorageKey(contentKey) === storageKey) {
          groupFor(contentKey).content = value;
          continue;
        }
        const summariesKey = recordKeyFromStorageDocument(storageKey, ':summaries');
        if (summariesKey && summariesStorageKey(summariesKey) === storageKey) {
          groupFor(summariesKey).summaries = value;
          continue;
        }
        // Unknown record-namespace documents may belong to a newer extension
        // version. Leave them for explicit per-page/all-page cleanup.
      }

      const current = await readIndex();
      const next = { keys: [], meta: {} };
      const seen = new Set();
      const addRecord = (key, group) => {
        if (
          seen.has(key) ||
          !group?.meta ||
          typeof group.meta !== 'object' ||
          Array.isArray(group.meta)
        )
          return;
        seen.add(key);
        next.keys.push(key);
        next.meta[key] = buildRecordMeta({ ...(group.content || {}), ...group.meta, key });
      };

      // Preserve current ordering, then append records recovered from storage.
      for (const key of current.keys) addRecord(key, groups.get(key));
      for (const [key, group] of groups) addRecord(key, group);

      for (const [key, group] of groups) {
        if (group.meta && typeof group.meta === 'object' && !Array.isArray(group.meta)) continue;
        if (group.metaStorageKey) invalidKeys.push(group.metaStorageKey);
        if (group.content) invalidKeys.push(contentStorageKey(key));
        if (group.summaries) invalidKeys.push(summariesStorageKey(key));
      }

      if (invalidKeys.length) await removeLocal(invalidKeys);
      if (JSON.stringify(current) !== JSON.stringify(next)) await writeIndex(next);

      return {
        recordCount: next.keys.length,
        recoveredCount: next.keys.filter((key) => !current.keys.includes(key)).length,
        removedKeys: invalidKeys.length,
      };
    }),
  );
}

/**
 * Finds a record in storage by its source URL. Only reads the small meta doc
 * for each indexed key — never the content/summaries docs — since
 * `sourceUrl` never lives there; the full record is only read once, for the
 * actual match.
 * @param {string} url - The URL of the source page to match.
 * @returns {Promise<object | null>} The matching record, or null if not found.
 */
export async function findRecordByUrl(url) {
  if (!url) return null;
  const idx = await readIndex();
  if (!idx.keys.length) return null;
  const items = await getLocal(idx.keys.map(metaStorageKey));
  for (const k of idx.keys) {
    const meta = items[metaStorageKey(k)];
    if (meta && meta.sourceUrl === url) {
      return readRecord(k);
    }
  }
  return null;
}
