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
import { createLogger } from '../../src/shared/runtime/log.js';

const log = createLogger();

export const INDEX_KEY = 'pagetollm:index';
const MAX_PROCESSING_LOG_ENTRIES = 80;
const RECORD_SNIPPET_MAX_CHARS = 500;
export const INDEX_REPAIR_THROTTLE_MS = 5 * 60 * 1000;
export const RECORD_STORAGE_PREFIX = 'pagetollm:rec:';
let lastIndexProjectionRepairAt = null;

// A record is physically split across three storage keys so that the
// high-frequency writes (status/progress/log ticks) never have to
// re-serialize the large, rarely-changing payload (html/text/sentences/
// topics) or the moderately-changing per-topic summaries:
//   - meta: everything else — the hot path, written on nearly every pipeline
//     step.
//   - content: html/text/sentences/topics/topic_range_chunks — written a
//     handful of times per run (essentially write-once). topic_range_chunks is
//     the topic-ranges chunk checkpoint; it lives here rather than in meta
//     because every meta write re-serializes on the hot path. It is updated
//     after successful topic-range parse rounds and cleared when that stage
//     succeeds.
//   - summaries: topic_summaries is the resumable leaf-work checkpoint;
//     topic_summary_index is the canonical UI projection; source_summary_units
//     is the optional per-request source-summary checkpoint. The checkpoints
//     stay load-bearing even though UI code never reads them directly.
const CONTENT_FIELDS = ['html', 'text', 'sentences', 'topics', 'topic_range_chunks'];
const SUMMARY_FIELDS = ['topic_summaries', 'topic_summary_index', 'source_summary_units'];
const RECORD_PAYLOAD_SCHEMAS = Object.freeze([
  { name: 'content', fields: CONTENT_FIELDS, storageKey: contentStorageKey },
  { name: 'summaries', fields: SUMMARY_FIELDS, storageKey: summariesStorageKey },
]);

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

/** Everything that isn't explicitly content or summaries lives in meta.
 * @param {object} obj Record-like object.
 */
function pickMetaFields(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!CONTENT_FIELDS.includes(k) && !SUMMARY_FIELDS.includes(k)) out[k] = v;
  }
  return out;
}

/**
 * Returns this module's realm-scoped state to its initial condition. Buffered
 * log disposal is the production lifecycle hook (`disposeProcessingLogs`); the
 * mutation-queue and repair-throttle resets are test-only, since neither has a
 * meaning outside a fresh realm.
 */
export function _resetUpdateQueues() {
  resetUpdateQueues();
  lastIndexProjectionRepairAt = null;
  disposeProcessingLogs();
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
 * @param {object} rec Record metadata source.
 */
function buildRecordMeta(rec) {
  return {
    sourceUrl: rec.sourceUrl,
    snippet: buildRecordSnippet(rec),
    createdAt: rec.createdAt,
    status: rec.status,
    progress: rec.progress,
    error: rec.error,
    // Outcome flags, not the run directive. Listings use both to offer summary
    // generation, while viewers only use `summariesDisabled` to hide summaries.
    summariesDisabled: rec.summariesDisabled === true,
    summariesIncomplete: rec.summariesIncomplete === true,
  };
}

const INDEX_META_FIELDS = [
  'status',
  'progress',
  'error',
  'text',
  'sourceUrl',
  'summariesDisabled',
  'summariesIncomplete',
];

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
 * @param {string} key Record key.
 * @param {object} patch Partial record update.
 * @param {object} fallbackMeta Existing metadata fallback.
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
      if (hasOwn(patch, 'summariesIncomplete'))
        next.summariesIncomplete = patch.summariesIncomplete === true;
      if (hasOwn(patch, 'text')) next.snippet = buildRecordSnippet({ text: patch.text });
      if (next.createdAt === undefined) next.createdAt = fallbackMeta && fallbackMeta.createdAt;
      idx.meta[key] = next;
      await writeIndex(idx);
    });
  } catch (err) {
    // The meta document was already written when this projection write failed.
    // Retry from that authoritative document rather than merely replaying the
    // patch: a concurrent writer may have changed another projected field in
    // the meantime. If storage remains unavailable, listRecords() still
    // overlays the authoritative metadata for callers (including keepalive),
    // and retries persisting the repaired projection on its next read.
    try {
      await repairIndexedRecordProjection(key);
    } catch (repairErr) {
      log.warn('failed to sync index meta for', key, err);
      log.warn('failed to repair index meta for', key, repairErr);
    }
  }
}

/**
 * Copies fields that are authoritative in a record's meta document into an
 * existing index projection. The text snippet deliberately remains cached:
 * text lives in the separate content document and normal content writes
 * already update it through syncIndexMeta().
 * @param {object} meta Authoritative record metadata document.
 * @param {object} [cached] Existing lightweight index projection.
 * @returns {object} Repaired lightweight index projection.
 */
function mergeAuthoritativeMetaIntoProjection(meta, cached = {}) {
  return {
    ...cached,
    sourceUrl: meta.sourceUrl,
    createdAt: meta.createdAt,
    status: meta.status,
    progress: meta.progress,
    error: meta.error,
    summariesDisabled: meta.summariesDisabled === true,
    summariesIncomplete: meta.summariesIncomplete === true,
  };
}

function isRecordMeta(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Rebuilds one already-indexed record's lightweight projection from its
 * authoritative metadata. This is intentionally narrow: it is the recovery
 * path for an interrupted incremental index write, whereas startup's
 * reconcileRecordStorage() remains responsible for discovering unindexed
 * records and ownerless documents.
 * @param {string} key Record key whose existing projection should be repaired.
 * @returns {Promise<void>}
 */
async function repairIndexedRecordProjection(key) {
  return queuedUpdate(INDEX_KEY, async () => {
    const idx = await readIndex();
    if (!idx.keys.includes(key)) return;
    const meta = (await getLocal(metaStorageKey(key)))[metaStorageKey(key)];
    const next = { keys: [...idx.keys], meta: { ...idx.meta } };
    if (!isRecordMeta(meta)) {
      next.keys = next.keys.filter((item) => item !== key);
      delete next.meta[key];
    } else {
      next.meta[key] = mergeAuthoritativeMetaIntoProjection(meta, idx.meta[key]);
    }
    if (JSON.stringify(next) !== JSON.stringify(idx)) await writeIndex(next);
  });
}

/**
 * Reads and reassembles the full logical record from its three physical docs.
 * Returns `null` if none of them hold anything.
 * @param {string} key
 * @returns {Promise<ArticleRecord | null>}
 */
export async function readRecord(key) {
  const metaKey = metaStorageKey(key);
  const payloadKeys = RECORD_PAYLOAD_SCHEMAS.map(({ storageKey }) => storageKey(key));
  const docKeys = [metaKey, ...payloadKeys];
  const items = await getLocal(docKeys);
  if (!docKeys.some((docKey) => items[docKey])) return null;
  // Meta is applied last so its fields win over any stale copy of the same
  // field left behind in a payload doc by an older record layout.
  return Object.assign({}, ...payloadKeys.map((docKey) => items[docKey] || {}), items[metaKey]);
}

/**
 * @param {ArticleRecord} rec
 * @param {object} [options]
 * @param {boolean} [options.bumpContentRevision]
 * @returns {Promise<void>}
 */
export async function writeRecord(rec, options = {}) {
  if (!rec || !rec.key) throw new Error('writeRecord: record.key required');
  return queuedUpdate(MUTATION_QUEUE_KEY, () => {
    return queuedUpdate(rec.key, async () => {
      const metaKey = metaStorageKey(rec.key);
      const payloadKeys = RECORD_PAYLOAD_SCHEMAS.map(({ storageKey }) => storageKey(rec.key));
      const docKeys = [metaKey, ...payloadKeys];
      const existingMeta = await loadMetaForWrite(rec.key);
      // Snapshot what is about to be overwritten so the index-failure path
      // below can put it back. Only for a record that already exists: a
      // brand-new key has nothing to restore, and skipping the read keeps the
      // common submit path from pulling in the (possibly large) content doc.
      const priorDocs = existingMeta ? await getLocal(docKeys) : null;
      const contentRevision =
        options.bumpContentRevision === true
          ? createContentRevision()
          : typeof rec.contentRevision === 'string' && rec.contentRevision
            ? rec.contentRevision
            : existingMeta?.contentRevision || createContentRevision();
      const documents = { [metaKey]: { ...pickMetaFields(rec), contentRevision } };
      RECORD_PAYLOAD_SCHEMAS.forEach(({ fields, storageKey }) => {
        documents[storageKey(rec.key)] = pickFields(rec, fields);
      });
      await setLocal(documents);

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
        // The three docs were already replaced above, so a failed index write
        // has to undo them. Deleting is only correct for a record this call
        // created: for an existing key (an import collision, a resubmission)
        // deletion would destroy the HTML, topics and summaries this write was
        // merely replacing — a rollback that loses more than the write would
        // have. Restore the snapshot instead, removing only the docs that did
        // not exist before.
        await rollbackRecordDocs(rec.key, priorDocs, docKeys).catch((rollbackErr) => {
          log.warn(
            'writeRecord rollback failed for',
            rec.key,
            'after index write error:',
            rollbackErr,
          );
        });
        throw err;
      }
      if (existingMeta && options.bumpContentRevision === true) {
        await pruneChatsForContentRevision(rec.key, contentRevision).catch((err) => {
          log.warn('stale chat cleanup failed:', err);
        });
      }
    });
  });
}

/**
 * Restores the record docs captured before a `writeRecord` overwrite.
 * `priorDocs` is null when the record did not exist, in which case removing
 * every doc is the correct rollback.
 * @param {string} key Record key.
 * @param {object|null} priorDocs Snapshot taken before the overwrite.
 * @param {string[]} docKeys Meta, content and summaries storage keys.
 */
async function rollbackRecordDocs(key, priorDocs, docKeys) {
  if (!priorDocs) {
    await removeLocal(docKeys);
    return;
  }
  const restore = {};
  const remove = [];
  for (const docKey of docKeys) {
    if (priorDocs[docKey] === undefined) remove.push(docKey);
    else restore[docKey] = priorDocs[docKey];
  }
  if (Object.keys(restore).length) await setLocal(restore);
  if (remove.length) await removeLocal(remove);
}

/**
 * Loads a record's meta doc for a write path (updateRecord / log flush).
 * Only reads the small meta doc — the whole point of the split, since this
 * runs on nearly every pipeline step. Returns `null` if the record does not
 * exist.
 * @param {string} key Record key.
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
  if (
    hasOwn(options, 'expectedPipelineRunId') &&
    meta.pipelineRunId !== options.expectedPipelineRunId
  ) {
    return true;
  }
  return (
    hasOwn(options, 'expectedStatuses') &&
    (!Array.isArray(options.expectedStatuses) || !options.expectedStatuses.includes(meta.status))
  );
}

/**
 * @param {string} key
 * @param {Partial<ArticleRecord>} patch
 * @param {object} [options]
 * @param {boolean} [options.bumpContentRevision]
 * @param {unknown} [options.expectedPipelineRunId]
 * @param {string[]} [options.expectedStatuses] Statuses that may be replaced.
 * @returns {Promise<ArticleRecord | null>}
 */
export async function updateRecord(key, patch, options = {}) {
  return queuedUpdate(MUTATION_QUEUE_KEY, () => {
    return queuedUpdate(key, async () => {
      const meta = await loadMetaForWrite(key);
      if (!meta) return null;
      if (isStaleRun(meta, options)) return null;

      const touchesContent = CONTENT_FIELDS.some((f) => hasOwn(patch, f));
      const writes = {};
      const mergedPayloads = {};
      for (const { name, fields, storageKey } of RECORD_PAYLOAD_SCHEMAS) {
        if (!fields.some((field) => hasOwn(patch, field))) continue;
        const documentKey = storageKey(key);
        const current = (await getLocal(documentKey))[documentKey] || {};
        const merged = { ...current, ...pickFields(patch, fields) };
        writes[documentKey] = merged;
        mergedPayloads[name] = merged;
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
          log.warn('stale chat cleanup failed:', err);
        });
      }

      // Derived from the schema list rather than naming payloads inline, so a
      // new payload doc reaches callers as well as storage.
      return Object.assign(
        { ...mergedMeta },
        ...RECORD_PAYLOAD_SCHEMAS.map(({ name }) => mergedPayloads[name] || {}),
      );
    });
  });
}

// Pipeline stages fire a processingLog entry on nearly every LLM request and
// response (see orchestrator.js logPipeline), which used to mean one full
// read-modify-write of the record per entry. Entries are instead buffered in
// memory per record key and flushed as a single write once the buffer has
// been quiet for LOG_FLUSH_DELAY_MS (bounded from the first buffered entry,
// not reset per entry, so a sustained burst still flushes periodically).
//
// These realm-scoped maps share the mutation queue's lifetime so every caller
// coalesces through one buffer. Recycling may lose diagnostics; lifecycle
// disposal below prevents them from landing in the wrong record.
const LOG_FLUSH_DELAY_MS = 250;
/** @type {Map<string, {entries: object[], options: object, disposed?: boolean, deferred: {promise: Promise, resolve: Function, reject: Function}}>} */
const _logBuffers = new Map();
/** @type {Map<string, *>} */
const _logFlushTimers = new Map();
// Buffers that have been detached from _logBuffers (so new entries start a
// fresh buffer) but have not yet written: they are waiting on the mutation and
// key queues. A key can hold more than one, because appendProcessingLog
// detaches a stale run's buffer while the debounce flush of another may still
// be parked. They stay tracked here so disposeProcessingLogs can cancel a flush
// that is queued behind the very delete doing the disposing.
/** @type {Map<string, Set<object>>} */
const _flushingBuffers = new Map();

function createDeferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function trackFlushing(key, buf) {
  let inflight = _flushingBuffers.get(key);
  if (!inflight) {
    inflight = new Set();
    _flushingBuffers.set(key, inflight);
  }
  inflight.add(buf);
}

function untrackFlushing(key, buf) {
  const inflight = _flushingBuffers.get(key);
  if (!inflight) return;
  inflight.delete(buf);
  if (inflight.size === 0) _flushingBuffers.delete(key);
}

async function doFlushProcessingLog(key) {
  const buf = _logBuffers.get(key);
  if (!buf) return null;
  // Detach immediately so later entries start a new buffer under their own
  // run options, but stay cancellable until this flush actually owns the key
  // queue: deleteRecord/deleteAll dispose from inside that same critical
  // section, so a flush parked behind a delete must not write afterwards.
  _logBuffers.delete(key);
  trackFlushing(key, buf);
  const { entries, options } = buf;
  try {
    const result = await queuedUpdate(MUTATION_QUEUE_KEY, () =>
      queuedUpdate(key, async () => {
        if (!_flushingBuffers.get(key)?.has(buf)) return null;
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
    // A disposed buffer had its deferred settled by disposeProcessingLogs.
    if (!buf.disposed) buf.deferred.resolve(result);
    return result;
  } catch (err) {
    if (!buf.disposed) buf.deferred.reject(err);
    return null;
  } finally {
    untrackFlushing(key, buf);
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
 * Discards buffered entries without writing them. Called when the records they
 * describe are being removed: a buffer that outlives its record would otherwise
 * flush after the delete, and entries appended without an
 * `expectedPipelineRunId` bypass the stale-run guard, so a record recreated
 * inside the debounce window could inherit the deleted run's log.
 *
 * Pending `appendProcessingLog` promises resolve with `null` (the same value a
 * flush that finds no meta document produces) rather than rejecting, so
 * discarding cannot turn into an unhandled rejection on a diagnostic path.
 * @param {string} [key] Record key to discard; omit to discard every buffer.
 */
export function disposeProcessingLogs(key) {
  const keys =
    key === undefined
      ? [...new Set([..._logBuffers.keys(), ..._flushingBuffers.keys(), ..._logFlushTimers.keys()])]
      : [key];
  for (const k of keys) {
    const timer = _logFlushTimers.get(k);
    if (timer) {
      clearTimeout(timer);
      _logFlushTimers.delete(k);
    }
    const buf = _logBuffers.get(k);
    if (buf) {
      _logBuffers.delete(k);
      buf.disposed = true;
      buf.deferred.resolve(null);
    }
    // Cancel detached buffers too: a flush waiting on the mutation or key
    // queue would otherwise resume after the caller's delete and write into a
    // record that no longer exists (or was recreated in the meantime).
    for (const inflight of _flushingBuffers.get(k) ?? []) {
      inflight.disposed = true;
      inflight.deferred.resolve(null);
    }
    _flushingBuffers.delete(k);
  }
}

/**
 * @param {string} key
 * @param {string} stage
 * @param {Record<string, unknown>} [details]
 * @param {object} [options]  Identifies the pipeline
 *   run this entry belongs to; a buffer whose entries were queued under a
 *   different run id is treated as stale and flushed before this entry starts
 *   a new buffer under `options`.
 * @param {unknown} [options.expectedPipelineRunId]
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

/**
 * Rewrites the index projection from the authoritative meta documents.
 * Best-effort cache maintenance only: callers already hold correct data, so a
 * failure here is logged and swallowed rather than failing their read.
 * @returns {Promise<void>}
 */
async function repairAllIndexProjections() {
  await queuedUpdate(INDEX_KEY, async () => {
    // Re-read while holding the index queue so a concurrent incremental
    // projection write cannot be overwritten by this repair.
    const current = await readIndex();
    const currentMetaKeys = current.keys.map(metaStorageKey);
    const currentMetas = currentMetaKeys.length ? await getLocal(currentMetaKeys) : {};
    const next = { keys: [], meta: {} };
    for (const key of current.keys) {
      const authoritativeMeta = currentMetas[metaStorageKey(key)];
      if (!isRecordMeta(authoritativeMeta)) continue;
      next.keys.push(key);
      next.meta[key] = mergeAuthoritativeMetaIntoProjection(authoritativeMeta, current.meta[key]);
    }
    if (JSON.stringify(next) !== JSON.stringify(current)) await writeIndex(next);
  }).catch((err) => {
    // The caller's projections are still correct. Keeping the listing usable
    // matters most for terminal states, and a later scan retries after the
    // repair throttle expires.
    log.warn('failed to repair record index projection:', err);
  });
}

function shouldAttemptIndexProjectionRepair(now = Date.now()) {
  if (lastIndexProjectionRepairAt !== null) {
    const elapsed = now - lastIndexProjectionRepairAt;
    if (elapsed >= 0 && elapsed < INDEX_REPAIR_THROTTLE_MS) return false;
  }
  lastIndexProjectionRepairAt = now;
  return true;
}

/**
 * Lists every indexed record's metadata, read authoritatively.
 *
 * Cost, because this is called on hot paths (the 30s keepalive alarm, the popup
 * and Options listings): one index read plus one batched `getLocal` of EVERY
 * record's meta document — not an index-only read. When the cached projection
 * turns out to be stale, this read path may also WRITE: a throttled
 * `repairAllIndexProjections` attempt re-reads the index and every meta
 * document under the index queue before rewriting the cache. Authoritative
 * reads are never throttled; only this best-effort persistence repair is.
 * Content/summaries documents are never touched on this path.
 *
 * The extra reads are deliberate: the index is a cache, never the source of
 * truth for a record's status. `updateRecord` commits the small meta document
 * before its index projection, so a failed projection write would otherwise
 * hide a terminal error/done state from the popup, Options, and the keepalive
 * alarm indefinitely.
 * @returns {Promise<Array<Partial<ArticleRecord>>>}
 */
export async function listRecords() {
  const idx = await readIndex();
  const metaKeys = idx.keys.map(metaStorageKey);
  const metas = metaKeys.length ? await getLocal(metaKeys) : {};
  const out = [];
  const repaired = { keys: [], meta: {} };
  for (const k of idx.keys) {
    const authoritativeMeta = metas[metaStorageKey(k)];
    if (!isRecordMeta(authoritativeMeta)) continue;
    const meta = mergeAuthoritativeMetaIntoProjection(authoritativeMeta, idx.meta[k]);
    repaired.keys.push(k);
    repaired.meta[k] = meta;
    out.push({ key: k, ...meta });
  }
  if (JSON.stringify(repaired) !== JSON.stringify(idx) && shouldAttemptIndexProjectionRepair()) {
    await repairAllIndexProjections();
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
        // Under the key queue and only once the documents are actually gone:
        // a failed remove leaves the record alive, so its buffered entries
        // must survive too.
        disposeProcessingLogs(key);
        try {
          await writeIndex(nextIdx);
        } catch (err) {
          // Documents are gone but retaining an index entry would create a
          // ghost record. Best-effort removal keeps listings authoritative.
          await writeIndex(nextIdx).catch((retryErr) => {
            log.warn(
              'deleteRecord failed to retry index write for',
              key,
              'after initial write error:',
              retryErr,
            );
          });
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
      const keys = [...(await allRecordStorageKeys()), ...(await allChatStorageKeys()), INDEX_KEY];
      await removeLocal([...new Set(keys)]);
      // Still holding MUTATION_QUEUE_KEY, which every flush must pass through,
      // so no buffered entry can slip in behind this removal.
      disposeProcessingLogs();
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
 * @returns {Promise<ArticleRecord | null>} The matching record, or null if not found.
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
