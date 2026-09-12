// The record index: a cache, never the source of truth. It holds one
// lightweight projection per record so listings never read the full payload
// documents, plus the two repair strategies that rebuild those projections
// from the authoritative `:meta` documents when an incremental write is
// interrupted — narrow (one record, on write failure) and throttled-wide (every
// indexed record, on a listing that notices drift).
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
 * returned by `listRecords`. Kept separate from the full record so that
 * frequent metadata-only changes (status/progress ticks) never require
 * reading or writing every record's full payload (html/text/sentences/
 * topics/summaries) just to keep listings up to date.
 * @param {object} rec Record metadata source.
 */
export function buildRecordMeta(rec, { snippet = buildRecordSnippet(rec) } = {}) {
  return {
    sourceUrl: rec.sourceUrl,
    snippet,
    // Text generation the cached snippet was taken from. Startup
    // reconciliation compares it against the (small) meta document to decide
    // whether it has to read the record's content document at all; a missing
    // or mismatched value only means the snippet is re-derived.
    snippetRevision: rec.textRevision,
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
    // Retry from that authoritative document rather than merely replaying the
    // patch: a concurrent writer may have changed another projected field in
    // the meantime. If storage remains unavailable, listRecords() still
    // overlays the authoritative metadata for callers (including keepalive),
    // and retries persisting the repaired projection on its next read.
    try {
      // The repair below rebuilds the projection from the meta document only,
      // so it cannot restore a snippet this failed write was carrying. It does
      // not have to: the meta document already committed a new textRevision,
      // which no longer matches the projection's snippetRevision, so the next
      // reconciliation re-reads the content document and recomputes it.
      await repairIndexedRecordProjection(key);
    } catch (repairErr) {
      log.warn('failed to sync index meta for', key, err);
      log.warn('failed to repair index meta for', key, repairErr);
    }
  }
}

/**
 * Copies fields that are authoritative in a record's meta document into an
 * existing index projection. The text snippet — and the `snippetRevision`
 * marker naming the generation it was taken from — deliberately remains
 * cached: text lives in the separate content document and normal content
 * writes already update both through syncIndexMeta().
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
