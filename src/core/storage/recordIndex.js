// Record listing cache: lightweight projections from authoritative :meta
// documents. Repair one entry after a failed write, or rebuild the index when
// a listing detects drift.
import { getLocal, setLocal, queuedUpdate } from './primitives.js';
import { recordMetaStorageKey as metaStorageKey } from './keys.js';
import { buildRecordSnippet, hasOwn, isCurrentRecordMeta } from './recordMeta.js';
import { createLogger } from '../../shared/runtime/log.js';

const log = createLogger();

export const INDEX_KEY = 'pagetollm:index';
export const INDEX_REPAIR_THROTTLE_MS = 5 * 60 * 1000;
let lastIndexProjectionRepairAt = null;

/**
 * Test-only: drops the wide-repair throttle so a fresh realm does not inherit
 * the previous test's last-repair timestamp.
 */
export function _resetIndexRepairThrottle() {
  lastIndexProjectionRepairAt = null;
}

export async function readIndex() {
  const items = await getLocal(INDEX_KEY);
  const idx = items[INDEX_KEY];
  if (idx && Array.isArray(idx.keys)) {
    return { keys: idx.keys, meta: idx.meta && typeof idx.meta === 'object' ? idx.meta : {} };
  }
  return { keys: [], meta: {} };
}

export async function writeIndex(idx) {
  await setLocal({ [INDEX_KEY]: idx });
}

/**
 * The lightweight projection of a record cached in the index (`meta`) and
 * returned by `listRecords`. Kept apart from the full record so frequent
 * metadata-only changes (status/progress ticks) never read or write every
 * record's full payload.
 * @param {object} rec Record metadata source.
 * @param {object} [options] Index projection options.
 * @param {string} [options.snippet] Precomputed snippet; derived from the record by default.
 */
export function buildRecordMeta(rec, { snippet = buildRecordSnippet(rec) } = {}) {
  return {
    sourceUrl: rec.sourceUrl,
    snippet,
    // Text generation the cached snippet came from. Startup reconciliation
    // compares it with the small meta document to decide whether to read the
    // content document; a missing or mismatched value only means re-deriving.
    snippetRevision: rec.textRevision,
    createdAt: rec.createdAt,
    status: rec.status,
    progress: rec.progress,
    error: rec.error,
    // Outcome flags, not the run directive. Listings use both to offer summary
    // generation, while viewers only use `summariesDisabled` to hide summaries.
    summariesDisabled: rec.summariesDisabled === true,
    summariesIncomplete: rec.summariesIncomplete === true,
    // Outcome of the last topic-card Resplit that left the topics unchanged.
    resplitNotice: rec.resplitNotice || null,
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
  'resplitNotice',
];

/**
 * Best-effort, incremental refresh of a record's cached index projection. Reads
 * and writes only the small `patch` fields the projection uses (plus what was
 * already cached), never the full record. The snippet is recomputed only when
 * `patch.text` is present. Skipped when `patch` touches no projected field, so
 * processingLog-only writes never touch the index. A failure only leaves the
 * cached listing momentarily stale, never threatens the record write that
 * already succeeded, so it is swallowed.
 * @param {string} key Record key.
 * @param {object} patch Partial record update.
 * @param {object} fallbackMeta Existing metadata fallback.
 */
export async function syncIndexMeta(key, patch, fallbackMeta) {
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
      if (hasOwn(patch, 'resplitNotice')) next.resplitNotice = patch.resplitNotice || null;
      if (hasOwn(patch, 'text')) {
        next.snippet = buildRecordSnippet({ text: patch.text });
        next.snippetRevision = fallbackMeta && fallbackMeta.textRevision;
      }
      if (next.createdAt === undefined) next.createdAt = fallbackMeta && fallbackMeta.createdAt;
      idx.meta[key] = next;
      await writeIndex(idx);
    });
  } catch (err) {
    // The meta document was already written when this projection write failed.
    // Retry from it rather than replaying the patch: a concurrent writer may have
    // changed another projected field. If storage stays unavailable, listRecords()
    // still overlays the authoritative metadata and retries persisting the repair.
    try {
      // The repair rebuilds from the meta document only, so it cannot restore a
      // snippet this write carried. It need not: the meta document already
      // committed a new textRevision that mismatches snippetRevision, so the next
      // reconciliation re-reads the content and recomputes it.
      await repairIndexedRecordProjection(key);
    } catch (repairErr) {
      log.warn('failed to sync index meta for', key, err);
      log.warn('failed to repair index meta for', key, repairErr);
    }
  }
}

/**
 * Copies fields that are authoritative in a record's meta document into an
 * existing index projection. The text snippet and its `snippetRevision` marker
 * stay cached: text lives in the content document, whose writes already update
 * both through syncIndexMeta().
 * @param {object} meta Authoritative record metadata document.
 * @param {object} [cached] Existing lightweight index projection.
 * @returns {object} Repaired lightweight index projection.
 */
function mergeAuthoritativeMetaIntoProjection(meta, cached = {}) {
  return {
    ...cached,
    sourceUrl: meta.sourceUrl,
    topicsRevision: meta.topicsRevision,
    createdAt: meta.createdAt,
    status: meta.status,
    progress: meta.progress,
    error: meta.error,
    summariesDisabled: meta.summariesDisabled === true,
    summariesIncomplete: meta.summariesIncomplete === true,
    resplitNotice: meta.resplitNotice || null,
  };
}

/**
 * Rebuilds one already-indexed record's projection from its authoritative
 * metadata: the recovery path for an interrupted incremental index write.
 * Discovering unindexed records and ownerless documents stays with startup's
 * reconcileRecordStorage().
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
 * Cost (hot paths: the 30s keepalive alarm, popup and Options listings): one
 * index read plus one batched `getLocal` of EVERY record's meta document.
 * When the cached projection is stale this path may also WRITE: a throttled
 * `repairAllIndexProjections` re-reads the index and every meta document under
 * the index queue before rewriting the cache. Authoritative reads are never
 * throttled, only that persistence repair. Content/summaries documents are
 * never touched.
 *
 * The extra reads are deliberate: the index is a cache, not the source of truth
 * for status. `updateRecord` commits the meta document before its index
 * projection, so a failed projection write would otherwise hide a terminal
 * error/done state from the popup, Options and the keepalive alarm.
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
    // snippetRevision is cache bookkeeping for reconciliation, not part of the
    // record a listing caller sees.
    const { snippetRevision: _snippetRevision, ...view } = meta;
    out.push({ key: k, ...view });
  }
  if (JSON.stringify(repaired) !== JSON.stringify(idx) && shouldAttemptIndexProjectionRepair()) {
    await repairAllIndexProjections();
  }
  return out;
}
