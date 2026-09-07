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
} from './keys.js';
import {
  RECORD_STORAGE_PREFIX,
  RECORD_STORAGE_SCHEMA_VERSION,
  createContentRevision,
  hasOwn,
  isCurrentRecordMeta,
  isStaleRun,
  loadMetaForWrite,
} from './recordMeta.js';
import {
  INDEX_KEY,
  buildRecordMeta,
  readIndex,
  syncIndexMeta,
  writeIndex,
  _resetIndexRepairThrottle,
} from './recordIndex.js';
import { disposeProcessingLogs } from './processingLog.js';
import { createLogger } from '../../src/shared/runtime/log.js';

// This module is the record repository's public surface. Partitioning, record
// CRUD and the checkpoint writers live here; the index cache, the buffered
// processing log and storage reconciliation live in the sibling modules
// re-exported below, so callers keep importing one module.
export { INDEX_KEY, INDEX_REPAIR_THROTTLE_MS, listRecords } from './recordIndex.js';
export {
  RECORD_STORAGE_PREFIX,
  RECORD_STORAGE_SCHEMA_VERSION,
  buildRecordSnippet,
} from './recordMeta.js';
export { appendProcessingLog, disposeProcessingLogs, flushProcessingLog } from './processingLog.js';
export { reconcileRecordStorage } from './recordReconcile.js';

const log = createLogger();

export const SOURCE_SUMMARY_UNIT_REVISION_MISMATCH = Object.freeze({
  reason: 'content_revision_mismatch',
});

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
 * Returns the repository's realm-scoped state — spread across this module,
 * recordIndex.js and processingLog.js — to its initial condition. Buffered
 * log disposal is the production lifecycle hook (`disposeProcessingLogs`); the
 * mutation-queue and repair-throttle resets are test-only, since neither has a
 * meaning outside a fresh realm.
 */
export function _resetUpdateQueues() {
  resetUpdateQueues();
  _resetIndexRepairThrottle();
  disposeProcessingLogs();
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
 * @param {boolean} [options.onlyIfAbsent] Create-if-absent: commit nothing and
 *   resolve false when the key already exists. The existence check runs inside
 *   this key's mutation queue, so two concurrent creators cannot both observe
 *   an absent record and both write.
 * @returns {Promise<boolean>} Whether this call committed the record.
 */
export async function writeRecord(rec, options = {}) {
  if (!rec || !rec.key) throw new Error('writeRecord: record.key required');
  return queuedUpdate(MUTATION_QUEUE_KEY, () => {
    return queuedUpdate(rec.key, async () => {
      const metaKey = metaStorageKey(rec.key);
      const docKeys = staticRecordDocumentKeys(rec.key);
      const existingMeta = await loadMetaForWrite(rec.key);
      if (options.onlyIfAbsent === true && existingMeta) return false;
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
      // This write always replaces the content document, so the snippet the
      // index caches is always from this generation. See mintTextRevision().
      const textRevision = createContentRevision();
      const documents = {
        [metaKey]: {
          ...pickMetaFields(rec),
          storageSchemaVersion: RECORD_STORAGE_SCHEMA_VERSION,
          contentRevision,
          textRevision,
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
          idx.meta[rec.key] = buildRecordMeta({ ...rec, contentRevision, textRevision });
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
      return true;
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
      // Committed in the same setLocal() as the content document below, so a
      // worker that dies before the index projection is updated always leaves
      // a meta document whose marker no longer matches the cached snippet.
      if (hasOwn(patch, 'text')) mergedMeta.textRevision = createContentRevision();
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

/**
 * Normalizes a record's picked-block selector list for identity comparison.
 * Order is not part of a selection's identity: the capture walks the DOM, so
 * the same picked blocks can arrive in a different order between submissions.
 * @param {*} value Raw `selectors` value from a record or submission.
 * @returns {string[]} Sorted, de-duplicated, non-empty selector strings.
 */
function normalizeSelectors(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((sel) => typeof sel === 'string' && sel))].sort();
}

/**
 * @param {string[]} a Normalized selector list.
 * @param {string[]} b Normalized selector list.
 */
function selectorsEqual(a, b) {
  return a.length === b.length && a.every((sel, i) => sel === b[i]);
}

/**
 * Finds a record in storage by its source URL. Only reads the small meta doc
 * for each indexed key — never the content/summaries docs — since neither
 * `sourceUrl` nor `selectors` lives there; the full record is only read once,
 * for the actual match.
 *
 * A single page can hold several independently picked blocks (chapter 1 and
 * chapter 2 of one long article), and each is its own record. The URL alone
 * therefore does not identify a record: when the caller names the blocks it
 * picked, a record only matches if it was built from the same selection.
 * Selectors are compared only when both sides have them — records written
 * without a selection (imports, pre-selector records) stay reachable by URL
 * alone, so they keep being refreshed in place rather than duplicated.
 *
 * @param {string} url - The URL of the source page to match.
 * @param {object} [options]
 * @param {string[]} [options.selectors] - Picked-block selectors to match on.
 * @returns {Promise<ArticleRecord | null>} The matching record, or null if not found.
 */
export async function findRecordByUrl(url, { selectors } = {}) {
  if (!url) return null;
  const idx = await readIndex();
  if (!idx.keys.length) return null;
  const items = await getLocal(idx.keys.map(metaStorageKey));
  const wanted = normalizeSelectors(selectors);
  // Only used when the caller named a selection: the first selector-less
  // record on this URL, taken as a match when no record carries that selection.
  let fallbackKey = null;
  for (const k of idx.keys) {
    const meta = items[metaStorageKey(k)];
    if (!isCurrentRecordMeta(meta) || meta.sourceUrl !== url) continue;
    if (!wanted.length) return readRecord(k);
    const found = normalizeSelectors(meta.selectors);
    if (selectorsEqual(found, wanted)) return readRecord(k);
    if (!found.length && fallbackKey === null) fallbackKey = k;
  }
  return fallbackKey === null ? null : readRecord(fallbackKey);
}
