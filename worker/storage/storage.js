import {
  getLocal,
  getLocalByPrefixes,
  getLocalKeysByPrefix,
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
  recordSummaryOutputStorageKey as summaryOutputStorageKey,
  recordTopicRangeCheckpointStorageKey as topicRangeCheckpointStorageKey,
  recordDiagnosticsStorageKey as diagnosticsStorageKey,
  recordSummaryLeafStoragePrefix as summaryLeafStoragePrefix,
  recordSummaryLeafStorageKey as summaryLeafStorageKey,
  recordSourceSummaryUnitStoragePrefix as sourceSummaryUnitStoragePrefix,
  recordSourceSummaryUnitStorageKey as sourceSummaryUnitStorageKey,
  recordStoragePrefix,
  decodeRecordStorageSegment,
} from './keys.js';
import { createLogger } from '../../src/shared/runtime/log.js';

const log = createLogger();

export const INDEX_KEY = 'pagetollm:index';
const MAX_PROCESSING_LOG_ENTRIES = 80;
const RECORD_SNIPPET_MAX_CHARS = 500;
export const INDEX_REPAIR_THROTTLE_MS = 5 * 60 * 1000;
export const RECORD_STORAGE_PREFIX = 'pagetollm:rec:';
export const RECORD_STORAGE_SCHEMA_VERSION = 2;
export const SOURCE_SUMMARY_UNIT_REVISION_MISMATCH = Object.freeze({
  reason: 'content_revision_mismatch',
});
let lastIndexProjectionRepairAt = null;

// Storage is organized by mutation unit, not by the old monolithic logical
// ArticleRecord shape. Large immutable content and final UI output have one
// document each. Topic-range work and diagnostics have independent documents.
// Leaf summaries and source-summary units use one key per entry, so completing
// one paid provider request never reserializes all previously completed work.
const CONTENT_FIELDS = ['html', 'capturedText', 'text', 'sentences', 'topics'];
const SUMMARY_OUTPUT_FIELDS = ['topic_summary_index'];
const SPECIAL_FIELDS = [
  ...CONTENT_FIELDS,
  ...SUMMARY_OUTPUT_FIELDS,
  'topic_range_chunks',
  'topic_summaries',
  'source_summary_units',
  'processingLog',
];
const RECORD_PAYLOAD_SCHEMAS = Object.freeze([
  { name: 'content', fields: CONTENT_FIELDS, storageKey: contentStorageKey },
  { name: 'summaryOutput', fields: SUMMARY_OUTPUT_FIELDS, storageKey: summaryOutputStorageKey },
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

/** Everything that isn't assigned to another document lives in meta.
 * @param {object} obj Record-like object.
 */
function pickMetaFields(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!SPECIAL_FIELDS.includes(k)) out[k] = v;
  }
  return out;
}

function summaryLeafDocuments(key, summaries, contentRevision, collectionRevision) {
  const documents = {};
  // Final/leaf summaries describe the imported article and are intentionally
  // re-scoped when an import collision mints a new content revision. Source
  // units are request-cache artifacts and are retained only on an exact
  // revision match (see sourceSummaryUnitDocuments below).
  for (const [topicPath, summary] of Object.entries(summaries || {})) {
    documents[summaryLeafStorageKey(key, topicPath)] = {
      topicPath,
      contentRevision,
      collectionRevision,
      summary,
    };
  }
  return documents;
}

function sourceSummaryUnitDocuments(key, units, contentRevision, collectionRevision) {
  const documents = {};
  for (const [unitId, unit] of Object.entries(units || {})) {
    if (unit?.contentRevision !== contentRevision) continue;
    documents[sourceSummaryUnitStorageKey(key, unitId)] = { ...unit, collectionRevision };
  }
  return documents;
}

function staticRecordDocumentKeys(key) {
  return [
    metaStorageKey(key),
    contentStorageKey(key),
    summaryOutputStorageKey(key),
    topicRangeCheckpointStorageKey(key),
    diagnosticsStorageKey(key),
  ];
}

async function readSummaryWorkDocuments(key) {
  // Prefix discovery is intentionally repeated. A module-level mirror becomes
  // stale when a read overlaps a mutation and grows without bound in a
  // long-lived worker. Callers inside the mutation queue therefore always see
  // the authoritative set of work keys, while view-only reads skip this scan.
  return getLocalByPrefixes([summaryLeafStoragePrefix(key), sourceSummaryUnitStoragePrefix(key)]);
}

function assembleSummaryWork(key, documents, meta) {
  const topicSummaries = {};
  const sourceSummaryUnits = {};
  const leafPrefix = summaryLeafStoragePrefix(key);
  const unitPrefix = sourceSummaryUnitStoragePrefix(key);
  for (const [storageKey, value] of Object.entries(documents)) {
    if (
      storageKey.startsWith(leafPrefix) &&
      value?.topicPath &&
      value?.contentRevision === meta.contentRevision &&
      value.collectionRevision === meta.topicSummariesRevision &&
      value?.summary
    ) {
      topicSummaries[value.topicPath] = value.summary;
    } else if (
      storageKey.startsWith(unitPrefix) &&
      value?.unitId &&
      value?.contentRevision === meta.contentRevision &&
      value.collectionRevision === meta.sourceSummaryUnitsRevision
    ) {
      const unit = { ...value };
      delete unit.collectionRevision;
      sourceSummaryUnits[value.unitId] = unit;
    }
  }
  return { topic_summaries: topicSummaries, source_summary_units: sourceSummaryUnits };
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

function isCurrentRecordMeta(value) {
  return isRecordMeta(value) && value.storageSchemaVersion === RECORD_STORAGE_SCHEMA_VERSION;
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
    if (!isCurrentRecordMeta(meta)) {
      next.keys = next.keys.filter((item) => item !== key);
      delete next.meta[key];
    } else {
      next.meta[key] = mergeAuthoritativeMetaIntoProjection(meta, idx.meta[key]);
    }
    if (JSON.stringify(next) !== JSON.stringify(idx)) await writeIndex(next);
  });
}

// A full read pairs one static read with a later work-document scan. A summary
// replacement committed between the two invalidates the pairing; retrying is
// cheap and a replacement cannot keep winning the race indefinitely.
const READ_RECORD_GENERATION_RETRIES = 3;

/**
 * Reports whether the summary generations a record's meta points at moved
 * between two reads of that meta.
 * @param {object} before
 * @param {object} [after]
 * @returns {boolean}
 */
function summaryGenerationsChanged(before, after) {
  if (!after) return true;
  return (
    before.contentRevision !== after.contentRevision ||
    before.topicSummariesRevision !== after.topicSummariesRevision ||
    before.sourceSummaryUnitsRevision !== after.sourceSummaryUnitsRevision
  );
}

/**
 * Reads and reassembles the full logical record from its normalized documents.
 * Returns `null` if none of them hold anything.
 * @param {string} key
 * @returns {Promise<ArticleRecord | null>}
 */
async function readRecordDocuments(key, { includeWork = true } = {}) {
  const metaKey = metaStorageKey(key);
  const payloadKeys = RECORD_PAYLOAD_SCHEMAS.map(({ storageKey }) => storageKey(key));
  const checkpointKey = topicRangeCheckpointStorageKey(key);
  const logKey = diagnosticsStorageKey(key);
  // Static record documents are committed together. Read them together too,
  // so a concurrent content replacement cannot pair one generation's meta
  // with another generation's payload.
  const docKeys = [metaKey, ...payloadKeys, ...(includeWork ? [checkpointKey] : []), logKey];
  for (let attempt = 0; ; attempt += 1) {
    const items = await getLocal(docKeys);
    const meta = items[metaKey];
    if (!isCurrentRecordMeta(meta)) return null;
    let workItems = {};
    if (includeWork) {
      workItems = await readSummaryWorkDocuments(key);
      // The work documents are read after (and outside of) the static read, so
      // a summary replacement landing in between would pair this meta with the
      // next generation's leaves, and assembleSummaryWork would then discard
      // every one of them by revision. Re-read the metadata and start over
      // when that happened, rather than reporting an empty summary set.
      const currentMeta = (await getLocal([metaKey]))[metaKey];
      if (summaryGenerationsChanged(meta, currentMeta)) {
        if (attempt < READ_RECORD_GENERATION_RETRIES) continue;
        const error = new Error(
          `readRecord: summary generations kept changing for ${key} after ${
            READ_RECORD_GENERATION_RETRIES + 1
          } attempts`,
        );
        log.warn(error.message);
        throw error;
      }
    }
    // Meta is applied last so its authoritative fields win over payload data.
    const record = Object.assign(
      {},
      ...payloadKeys.map((docKey) => items[docKey] || {}),
      includeWork ? { topic_range_chunks: items[checkpointKey]?.topic_range_chunks ?? null } : {},
      { processingLog: items[logKey]?.processingLog ?? [] },
      includeWork ? assembleSummaryWork(key, workItems, meta) : {},
      meta,
    );
    return record;
  }
}

export async function readRecord(key) {
  return readRecordDocuments(key);
}

export async function readRecordView(key) {
  return readRecordDocuments(key, { includeWork: false });
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
      const docKeys = staticRecordDocumentKeys(rec.key);
      const existingMeta = await loadMetaForWrite(rec.key);
      // Always discover work documents, including for a missing meta. A prior
      // interrupted delete can leave owner-shaped leaves behind; a new record
      // with the same key must replace, not silently adopt, those documents.
      const existingWorkDocuments = await readSummaryWorkDocuments(rec.key);
      // Snapshot what is about to be overwritten so the index-failure path
      // below can put it back. Only for a record that already exists: a
      // brand-new key has nothing to restore, and skipping the read keeps the
      // common submit path from pulling in the (possibly large) content doc.
      const priorDocs = existingMeta
        ? {
            ...(await getLocal(docKeys)),
            ...existingWorkDocuments,
          }
        : null;
      const contentRevision =
        options.bumpContentRevision === true
          ? createContentRevision()
          : typeof rec.contentRevision === 'string' && rec.contentRevision
            ? rec.contentRevision
            : existingMeta?.contentRevision || createContentRevision();
      // These generation markers are committed atomically with their new
      // leaves. If the worker dies before stale physical keys are removed,
      // the old generation remains unreadable and cannot be resurrected.
      const topicSummariesRevision = createContentRevision();
      const sourceSummaryUnitsRevision = createContentRevision();
      const documents = {
        [metaKey]: {
          ...pickMetaFields(rec),
          storageSchemaVersion: RECORD_STORAGE_SCHEMA_VERSION,
          contentRevision,
          topicSummariesRevision,
          sourceSummaryUnitsRevision,
        },
        ...summaryLeafDocuments(
          rec.key,
          rec.topic_summaries,
          contentRevision,
          topicSummariesRevision,
        ),
        ...sourceSummaryUnitDocuments(
          rec.key,
          rec.source_summary_units,
          contentRevision,
          sourceSummaryUnitsRevision,
        ),
      };
      if (rec.topic_range_chunks != null) {
        documents[topicRangeCheckpointStorageKey(rec.key)] = {
          topic_range_chunks: rec.topic_range_chunks,
        };
      }
      if (Array.isArray(rec.processingLog) && rec.processingLog.length > 0) {
        documents[diagnosticsStorageKey(rec.key)] = { processingLog: rec.processingLog };
      }
      RECORD_PAYLOAD_SCHEMAS.forEach(({ fields, storageKey }) => {
        documents[storageKey(rec.key)] = pickFields(rec, fields);
      });
      const priorKeys = [
        ...new Set([...Object.keys(priorDocs || {}), ...Object.keys(existingWorkDocuments)]),
      ];
      const staleKeys = priorKeys.filter((storageKey) => !hasOwn(documents, storageKey));
      await setLocal(documents);
      if (staleKeys.length) await removeLocal(staleKeys);

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
        // The aggregate documents were already replaced above, so a failed
        // index write has to undo them. Deleting is only correct for a record
        // this call created: for an existing key (an import collision, a resubmission)
        // deletion would destroy the HTML, topics and summaries this write was
        // merely replacing — a rollback that loses more than the write would
        // have. Restore the snapshot instead, removing only the docs that did
        // not exist before.
        await rollbackRecordDocs(priorDocs, [
          ...new Set([...docKeys, ...Object.keys(documents), ...priorKeys]),
        ]).catch((rollbackErr) => {
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
 * @param {object|null} priorDocs Snapshot taken before the overwrite.
 * @param {string[]} docKeys Every document owned by the aggregate.
 */
async function rollbackRecordDocs(priorDocs, docKeys) {
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
  const meta = items[metaKey];
  return isCurrentRecordMeta(meta) ? meta : null;
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
      const removes = [];
      const mergedPayloads = {};
      const replacesContentGeneration = touchesContent && options.bumpContentRevision === true;
      const workDocuments =
        replacesContentGeneration ||
        hasOwn(patch, 'topic_summaries') ||
        hasOwn(patch, 'source_summary_units')
          ? await readSummaryWorkDocuments(key)
          : {};
      const mergedMeta = { ...meta, ...pickMetaFields(patch), updatedAt: Date.now() };
      if (replacesContentGeneration) {
        mergedMeta.contentRevision = createContentRevision();
      }
      for (const { name, fields, storageKey } of RECORD_PAYLOAD_SCHEMAS) {
        if (!fields.some((field) => hasOwn(patch, field))) continue;
        const documentKey = storageKey(key);
        const current = (await getLocal(documentKey))[documentKey] || {};
        const merged = { ...current, ...pickFields(patch, fields) };
        writes[documentKey] = merged;
        mergedPayloads[name] = merged;
      }

      if (hasOwn(patch, 'topic_range_chunks')) {
        const documentKey = topicRangeCheckpointStorageKey(key);
        if (patch.topic_range_chunks == null) removes.push(documentKey);
        else writes[documentKey] = { topic_range_chunks: patch.topic_range_chunks };
        mergedPayloads.topicRangeCheckpoint = {
          topic_range_chunks: patch.topic_range_chunks ?? null,
        };
      }
      if (hasOwn(patch, 'processingLog')) {
        const documentKey = diagnosticsStorageKey(key);
        const processingLog = Array.isArray(patch.processingLog) ? patch.processingLog : [];
        if (processingLog.length === 0) removes.push(documentKey);
        else writes[documentKey] = { processingLog };
        const value = { processingLog };
        mergedPayloads.diagnostics = value;
      }
      if (hasOwn(patch, 'topic_summaries')) {
        const current = Object.fromEntries(
          Object.entries(workDocuments).filter(([storageKey]) =>
            storageKey.startsWith(summaryLeafStoragePrefix(key)),
          ),
        );
        mergedMeta.topicSummariesRevision = createContentRevision();
        const replacement = summaryLeafDocuments(
          key,
          patch.topic_summaries,
          mergedMeta.contentRevision,
          mergedMeta.topicSummariesRevision,
        );
        Object.assign(writes, replacement);
        removes.push(
          ...Object.keys(current).filter((storageKey) => !hasOwn(replacement, storageKey)),
        );
        mergedPayloads.topicSummaries = {
          topic_summaries:
            patch.topic_summaries && typeof patch.topic_summaries === 'object'
              ? patch.topic_summaries
              : {},
        };
      }
      if (hasOwn(patch, 'source_summary_units')) {
        const current = Object.fromEntries(
          Object.entries(workDocuments).filter(([storageKey]) =>
            storageKey.startsWith(sourceSummaryUnitStoragePrefix(key)),
          ),
        );
        mergedMeta.sourceSummaryUnitsRevision = createContentRevision();
        const replacement = sourceSummaryUnitDocuments(
          key,
          patch.source_summary_units,
          mergedMeta.contentRevision,
          mergedMeta.sourceSummaryUnitsRevision,
        );
        Object.assign(writes, replacement);
        removes.push(
          ...Object.keys(current).filter((storageKey) => !hasOwn(replacement, storageKey)),
        );
        mergedPayloads.sourceSummaryUnits = {
          source_summary_units:
            patch.source_summary_units && typeof patch.source_summary_units === 'object'
              ? patch.source_summary_units
              : {},
        };
      }

      if (replacesContentGeneration) {
        removes.push(
          ...Object.keys(workDocuments).filter((storageKey) => !hasOwn(writes, storageKey)),
        );
      }

      writes[metaStorageKey(key)] = mergedMeta;

      await setLocal(writes);
      if (removes.length) await removeLocal([...new Set(removes)]);
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
        mergedPayloads.topicRangeCheckpoint || {},
        mergedPayloads.diagnostics || {},
        mergedPayloads.topicSummaries || {},
        mergedPayloads.sourceSummaryUnits || {},
      );
    });
  });
}

/**
 * Persists one leaf checkpoint without reading or rewriting sibling leaves.
 * The current meta document is read only for the run-ownership guard.
 * @param {string} key
 * @param {string} topicPath
 * @param {object} summary
 * @param {object} [options]
 * @returns {Promise<object|null>}
 */
export async function putTopicSummaryCheckpoint(key, topicPath, summary, options = {}) {
  if (typeof topicPath !== 'string' || !topicPath) {
    throw new Error('putTopicSummaryCheckpoint: topicPath required');
  }
  return queuedUpdate(MUTATION_QUEUE_KEY, () =>
    queuedUpdate(key, async () => {
      const meta = await loadMetaForWrite(key);
      if (!meta || isStaleRun(meta, options)) return null;
      await setLocal({
        [summaryLeafStorageKey(key, topicPath)]: {
          topicPath,
          contentRevision: meta.contentRevision,
          collectionRevision: meta.topicSummariesRevision,
          summary,
        },
      });
      return summary;
    }),
  );
}

/**
 * Persists one completed source-summary provider unit in its own document.
 * @param {string} key
 * @param {object} unit
 * @param {object} [options]
 * @returns {Promise<object|null>} The unit, the exported revision-mismatch
 *   sentinel, or null when the record/run is no longer current.
 */
export async function putSourceSummaryUnit(key, unit, options = {}) {
  if (!unit || typeof unit.unitId !== 'string' || !unit.unitId) {
    throw new Error('putSourceSummaryUnit: unit.unitId required');
  }
  return queuedUpdate(MUTATION_QUEUE_KEY, () =>
    queuedUpdate(key, async () => {
      const meta = await loadMetaForWrite(key);
      if (!meta || isStaleRun(meta, options)) return null;
      if (unit.contentRevision !== meta.contentRevision) {
        return SOURCE_SUMMARY_UNIT_REVISION_MISMATCH;
      }
      await setLocal({
        [sourceSummaryUnitStorageKey(key, unit.unitId)]: {
          ...unit,
          collectionRevision: meta.sourceSummaryUnitsRevision,
        },
      });
      return unit;
    }),
  );
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
        const meta = await loadMetaForWrite(key);
        if (!meta) return null;
        if (isStaleRun(meta, options)) return null;

        const documentKey = diagnosticsStorageKey(key);
        const diagnostics = (await getLocal(documentKey))[documentKey] || {};
        const existing = Array.isArray(diagnostics.processingLog) ? diagnostics.processingLog : [];
        const processingLog = [...existing, ...entries].slice(-MAX_PROCESSING_LOG_ENTRIES);
        const mergedDiagnostics = { processingLog };

        await setLocal({ [documentKey]: mergedDiagnostics });
        return mergedDiagnostics;
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
      if (isCurrentRecordMeta(authoritativeMeta)) {
        next.keys.push(key);
        next.meta[key] = mergeAuthoritativeMetaIntoProjection(authoritativeMeta, current.meta[key]);
      }
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
    if (!isCurrentRecordMeta(authoritativeMeta)) continue;
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
async function allRecordStorageKeys() {
  return getLocalKeysByPrefix(RECORD_STORAGE_PREFIX);
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
        const recordKeys = await getLocalKeysByPrefix(recordStoragePrefix(key));
        const keys = [...recordKeys, ...(await chatStorageKeysForRecord(key))];
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
  const segment = storageKey.slice(RECORD_STORAGE_PREFIX.length, -suffix.length);
  return segment ? decodeRecordStorageSegment(segment) : null;
}

function recordKeyFromWorkDocument(storageKey, marker) {
  if (!storageKey.startsWith(RECORD_STORAGE_PREFIX)) return null;
  const markerIndex = storageKey.lastIndexOf(marker);
  if (
    markerIndex < RECORD_STORAGE_PREFIX.length ||
    markerIndex + marker.length >= storageKey.length
  ) {
    return null;
  }
  return decodeRecordStorageSegment(storageKey.slice(RECORD_STORAGE_PREFIX.length, markerIndex));
}

function recognizedRecordDocumentOwner(storageKey) {
  for (const suffix of [
    ':meta',
    ':content',
    ':summary-output',
    ':topic-range-work',
    ':diagnostics',
  ]) {
    const key = recordKeyFromStorageDocument(storageKey, suffix);
    if (key) return key;
  }
  return (
    recordKeyFromWorkDocument(storageKey, ':summary-leaf:') ||
    recordKeyFromWorkDocument(storageKey, ':summary-unit:')
  );
}

function workDocumentMatchesOwnerGeneration(storageKey, value, ownerMeta) {
  if (storageKey.startsWith(summaryLeafStoragePrefix(ownerMeta.key))) {
    return (
      value?.contentRevision === ownerMeta.contentRevision &&
      value?.collectionRevision === ownerMeta.topicSummariesRevision
    );
  }
  if (storageKey.startsWith(sourceSummaryUnitStoragePrefix(ownerMeta.key))) {
    return (
      value?.contentRevision === ownerMeta.contentRevision &&
      value?.collectionRevision === ownerMeta.sourceSummaryUnitsRevision
    );
  }
  return true;
}

/**
 * Removes invalid or ownerless record documents, then rebuilds the index from
 * records written in the current storage schema.
 */
export async function reconcileRecordStorage() {
  return queuedUpdate(MUTATION_QUEUE_KEY, () =>
    queuedUpdate(INDEX_KEY, async () => {
      const storageKeys = await getLocalKeysByPrefix(RECORD_STORAGE_PREFIX);
      // Work-document values are needed to collect checkpoints from superseded
      // content/collection generations. Static payloads still participate by
      // key only, except content which supplies the index snippet.
      const documents = await getLocal(
        storageKeys.filter(
          (storageKey) =>
            storageKey.endsWith(':meta') ||
            storageKey.endsWith(':content') ||
            storageKey.includes(':summary-leaf:') ||
            storageKey.includes(':summary-unit:'),
        ),
      );
      const groups = new Map();
      const currentKeys = new Set();
      const obsoleteKeys = new Set();

      for (const storageKey of storageKeys.filter((key) => key.endsWith(':meta'))) {
        const key = recordKeyFromStorageDocument(storageKey, ':meta');
        const meta = documents[storageKey];
        if (!key || metaStorageKey(key) !== storageKey || !isCurrentRecordMeta(meta)) {
          obsoleteKeys.add(storageKey);
          continue;
        }
        currentKeys.add(key);
        groups.set(key, { meta, content: documents[contentStorageKey(key)] || {} });
      }

      for (const storageKey of storageKeys) {
        if (storageKey.endsWith(':meta')) continue;
        const owner = recognizedRecordDocumentOwner(storageKey);
        if (
          !owner ||
          !storageKey.startsWith(recordStoragePrefix(owner)) ||
          !currentKeys.has(owner) ||
          !workDocumentMatchesOwnerGeneration(
            storageKey,
            documents[storageKey],
            groups.get(owner).meta,
          )
        ) {
          obsoleteKeys.add(storageKey);
        }
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

      for (const key of current.keys) addRecord(key, groups.get(key));
      for (const [key, group] of groups) addRecord(key, group);

      const uniqueObsoleteKeys = [...obsoleteKeys];
      if (uniqueObsoleteKeys.length) await removeLocal(uniqueObsoleteKeys);
      if (JSON.stringify(current) !== JSON.stringify(next)) await writeIndex(next);

      return {
        recordCount: next.keys.length,
        recoveredCount: next.keys.filter((key) => !current.keys.includes(key)).length,
        removedKeys: uniqueObsoleteKeys.length,
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
    if (isCurrentRecordMeta(meta) && meta.sourceUrl === url) {
      return readRecord(k);
    }
  }
  return null;
}
