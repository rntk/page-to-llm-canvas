// Storage reconciliation: a startup sweep over every physical record document
// that removes documents no current record owns, then rebuilds the index from
// the authoritative `:meta` documents. It is the only reader that walks the
// whole corpus, so it reads in bounded batches and reduces each slice to a
// decision or a snippet before dropping it.
import {
  getLocal,
  setLocal,
  removeLocal,
  getLocalKeysByPrefix,
  queuedUpdate,
  MUTATION_QUEUE_KEY,
} from './primitives.js';
import {
  recordMetaStorageKey as metaStorageKey,
  recordContentStorageKey as contentStorageKey,
  recordSummaryLeafStoragePrefix as summaryLeafStoragePrefix,
  recordSourceSummaryUnitStoragePrefix as sourceSummaryUnitStoragePrefix,
  recordStoragePrefix,
  decodeRecordStorageSegment,
} from './keys.js';
import {
  RECORD_STORAGE_PREFIX,
  buildRecordSnippet,
  createContentRevision,
  isCurrentRecordMeta,
  isFutureRecordMeta,
  isRecordMeta,
} from './recordMeta.js';
import { INDEX_KEY, buildRecordMeta, readIndex, writeIndex } from './recordIndex.js';
import { createLogger } from '../../shared/runtime/log.js';

const log = createLogger();

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

// Reconciliation walks every physical record document, so it reads storage in
// slices rather than pulling the whole corpus into one object: each slice is
// reduced to a decision (obsolete / keep) or a snippet string and then dropped.
// Work and meta documents are small; content documents carry the html, text,
// sentences and topics of a page, so they get a much smaller slice — and are
// only read for records whose cached snippet is missing or belongs to a
// superseded content generation.
const RECONCILE_METADATA_BATCH_SIZE = 50;
const RECONCILE_CONTENT_BATCH_SIZE = 10;

/**
 * Reads the given storage keys in bounded batches, handing each key and its
 * value to `visit`. Values are only reachable for the duration of their own
 * batch, so peak memory is proportional to the batch, not to the corpus.
 * @param {string[]} storageKeys
 * @param {number} batchSize
 * @param {(storageKey: string, value: unknown) => void} visit
 */
async function forEachStoredDocument(storageKeys, batchSize, visit) {
  for (let offset = 0; offset < storageKeys.length; offset += batchSize) {
    const slice = storageKeys.slice(offset, offset + batchSize);
    const documents = await getLocal(slice);
    for (const storageKey of slice) visit(storageKey, documents[storageKey]);
  }
}

/**
 * Gives records stored before `textRevision` existed a marker, so the snippet
 * just re-derived from their content document can be trusted on the next cold
 * start instead of costing another full content read every time.
 *
 * Safe to write here: reconciliation holds the global mutation queue, which
 * every writer passes through, so no concurrent write can be overwritten. It is
 * also best effort — a failure only means those records keep re-reading their
 * content, exactly as they did before the marker existed — so the metas are
 * only updated once the write has actually landed.
 * @param {Map<string, object>} metas Meta documents keyed by record key.
 */
async function backfillTextRevisions(metas) {
  const pending = [];
  for (const [key, meta] of metas) {
    if (typeof meta.textRevision === 'string') continue;
    pending.push([key, { ...meta, textRevision: createContentRevision() }]);
  }
  for (let offset = 0; offset < pending.length; offset += RECONCILE_METADATA_BATCH_SIZE) {
    const slice = pending.slice(offset, offset + RECONCILE_METADATA_BATCH_SIZE);
    try {
      await setLocal(Object.fromEntries(slice.map(([key, meta]) => [metaStorageKey(key), meta])));
    } catch (err) {
      // Leave the remaining records unmarked rather than retrying into a
      // storage area that is refusing writes; the next cold start tries again.
      log.warn('failed to backfill record text revisions:', err);
      return;
    }
    for (const [key, meta] of slice) metas.set(key, meta);
  }
}

/**
 * Removes invalid or ownerless record documents, then rebuilds the index from
 * records written in the current storage schema.
 *
 * Schema policy: records older than the current schema (no or a lower
 * `storageSchemaVersion`) are deliberately dropped, not migrated. Records from
 * a newer schema are quarantined in place: they and every document under their
 * key prefix are left untouched and kept out of the index, so a later upgrade
 * finds them intact.
 */
export async function reconcileRecordStorage() {
  return queuedUpdate(MUTATION_QUEUE_KEY, () =>
    queuedUpdate(INDEX_KEY, async () => {
      const storageKeys = await getLocalKeysByPrefix(RECORD_STORAGE_PREFIX);
      const metaKeys = [];
      // Work-document values are needed to collect checkpoints from superseded
      // content/collection generations. Every other payload document
      // participates by key only.
      const workKeys = [];
      const payloadKeys = [];
      for (const storageKey of storageKeys) {
        if (storageKey.endsWith(':meta')) metaKeys.push(storageKey);
        else if (storageKey.includes(':summary-leaf:') || storageKey.includes(':summary-unit:'))
          workKeys.push(storageKey);
        else payloadKeys.push(storageKey);
      }

      const metas = new Map();
      const quarantinedPrefixes = new Set();
      const obsoleteKeys = new Set();
      await forEachStoredDocument(metaKeys, RECONCILE_METADATA_BATCH_SIZE, (storageKey, meta) => {
        const key = recordKeyFromStorageDocument(storageKey, ':meta');
        if (!key || metaStorageKey(key) !== storageKey) {
          obsoleteKeys.add(storageKey);
        } else if (isFutureRecordMeta(meta)) {
          quarantinedPrefixes.add(recordStoragePrefix(key));
        } else if (!isCurrentRecordMeta(meta)) {
          obsoleteKeys.add(storageKey);
        } else {
          metas.set(key, meta);
        }
      });
      if (quarantinedPrefixes.size) {
        log.warn(
          `leaving ${quarantinedPrefixes.size} record(s) from a newer storage schema untouched`,
        );
      }
      // A newer schema may add document kinds this build does not recognise,
      // so quarantine goes by key prefix rather than by known suffixes. Record
      // key segments are URI-encoded and never contain `:`, so the owning
      // prefix is everything up to the first `:` after the namespace.
      const isQuarantined = (storageKey) => {
        const end = storageKey.indexOf(':', RECORD_STORAGE_PREFIX.length);
        return end !== -1 && quarantinedPrefixes.has(storageKey.slice(0, end + 1));
      };

      const ownedByCurrentRecord = (storageKey) => {
        const owner = recognizedRecordDocumentOwner(storageKey);
        return owner && storageKey.startsWith(recordStoragePrefix(owner)) && metas.has(owner)
          ? owner
          : null;
      };

      for (const storageKey of payloadKeys) {
        if (!ownedByCurrentRecord(storageKey) && !isQuarantined(storageKey)) {
          obsoleteKeys.add(storageKey);
        }
      }
      const ownWorkKeys = workKeys.filter((storageKey) => !isQuarantined(storageKey));
      await forEachStoredDocument(ownWorkKeys, RECONCILE_METADATA_BATCH_SIZE, (storageKey, value) => {
        const owner = ownedByCurrentRecord(storageKey);
        if (!owner || !workDocumentMatchesOwnerGeneration(storageKey, value, metas.get(owner))) {
          obsoleteKeys.add(storageKey);
        }
      });

      const current = await readIndex();
      // Reuse a cached snippet only when the meta document still names the text
      // generation it was taken from. Every writer commits that marker in the
      // same setLocal() as the content document and before the index write, so
      // a snippet that a terminated worker never got to update is always
      // detected here. Records written before the marker existed have none, and
      // are treated as stale (below).
      const snippets = new Map();
      const snippetContentKeys = [];
      for (const [key, meta] of metas) {
        const cached = current.meta?.[key];
        if (
          cached &&
          typeof cached.snippet === 'string' &&
          typeof meta.textRevision === 'string' &&
          cached.snippetRevision === meta.textRevision
        ) {
          snippets.set(key, cached.snippet);
        } else {
          snippetContentKeys.push(contentStorageKey(key));
        }
      }
      await forEachStoredDocument(
        snippetContentKeys,
        RECONCILE_CONTENT_BATCH_SIZE,
        (storageKey, content) => {
          const key = recordKeyFromStorageDocument(storageKey, ':content');
          if (key) snippets.set(key, buildRecordSnippet(content || {}));
        },
      );
      await backfillTextRevisions(metas);

      const next = { keys: [], meta: {} };
      const seen = new Set();
      const addRecord = (key) => {
        const meta = metas.get(key);
        if (seen.has(key) || !isRecordMeta(meta)) return;
        seen.add(key);
        next.keys.push(key);
        next.meta[key] = buildRecordMeta(
          { ...meta, key },
          { snippet: snippets.get(key) ?? buildRecordSnippet(null) },
        );
      };

      for (const key of current.keys) addRecord(key);
      for (const key of metas.keys()) addRecord(key);

      // The meta pass can mark a future record's documents obsolete (e.g. a
      // `…:cache:meta` doc) before that record's prefix is known.
      const uniqueObsoleteKeys = [...obsoleteKeys].filter((storageKey) => !isQuarantined(storageKey));
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
