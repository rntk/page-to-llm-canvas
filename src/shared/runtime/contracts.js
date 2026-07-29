// Browser-safe contracts shared by extension surfaces and the service worker.
// These values describe the persisted/wire representation; they deliberately
// remain plain strings and objects so Chrome storage and runtime messaging do
// not depend on JavaScript prototypes.

export const PIPELINE_STATUS = Object.freeze({
  PENDING: 'pending',
  SPLITTING: 'splitting',
  SUMMARIZING: 'summarizing',
  DONE: 'done',
  ERROR: 'error',
  CANCELLED: 'cancelled',
  NEEDS_ATTENTION: 'needs_attention',
});

export const PIPELINE_STAGE = Object.freeze({
  QUEUED: 'queued',
  CLEANING_HTML: 'cleaning_html',
  SPLITTING_SENTENCES: 'splitting_sentences',
  TOKENISING: 'tokenising',
  TOPIC_RANGES: 'topic_ranges',
  SUMMARIZING: 'summarizing',
  SUMMARIZING_TOPICS: 'summarizing_topics',
  NEEDS_ATTENTION: 'needs_attention',
  DONE: 'done',
  ERROR: 'error',
  CANCELLED: 'cancelled',
  IMPORTED: 'imported',
});

const PIPELINE_STATUS_VALUES = new Set(Object.values(PIPELINE_STATUS));
const PIPELINE_STAGE_VALUES = new Set(Object.values(PIPELINE_STAGE));
const IN_FLIGHT_PIPELINE_STATUSES = new Set([
  PIPELINE_STATUS.PENDING,
  PIPELINE_STATUS.SPLITTING,
  PIPELINE_STATUS.SUMMARIZING,
]);

/** @param {unknown} value @returns {boolean} */
function isImportableTopicSummaryIndex(value) {
  if (value == null) return true;
  if (typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).every(
    (entry) =>
      !!entry &&
      typeof entry === 'object' &&
      !Array.isArray(entry) &&
      Number.isInteger(entry.level) &&
      entry.level >= 0,
  );
}

/** @param {unknown} value @returns {boolean} */
export function isPipelineStatus(value) {
  return typeof value === 'string' && PIPELINE_STATUS_VALUES.has(value);
}

/** @param {unknown} value @returns {boolean} */
export function isPipelineStage(value) {
  return typeof value === 'string' && PIPELINE_STAGE_VALUES.has(value);
}

/** @param {unknown} value @returns {boolean} */
export function isInFlightPipelineStatus(value) {
  return isPipelineStatus(value) && IN_FLIGHT_PIPELINE_STATUSES.has(value);
}

/**
 * Identifies records that contain enough article data to be imported. This is
 * shared by the options page and service worker so both import paths enforce
 * the same minimum contract.
 *
 * @param {unknown} record
 * @returns {boolean}
 */
export function isImportableRecord(record) {
  return (
    !!record &&
    typeof record === 'object' &&
    typeof record.key === 'string' &&
    !!record.key.trim() &&
    typeof record.html === 'string' &&
    !!record.html.trim() &&
    isImportableTopicSummaryIndex(record.topic_summary_index)
  );
}

/**
 * The persisted shape of a page record (see `worker/storage/storage.js`,
 * which physically splits this object across meta/content/summaries storage
 * docs and reassembles it on read). Field names mix camelCase (`sourceUrl`,
 * `createdAt`, `pipelineRunId`, `contentRevision`) with snake_case
 * (`topic_summaries`, `topic_summary_index`, and the per-chunk
 * `start_sentence`/`end_sentence` keys nested inside `topic_summaries`
 * entries). This inconsistency is intentional/historical — the shape is
 * persisted in user storage, so renaming any of these keys would require a
 * storage migration, not just a code change.
 *
 * Optionality here is the intersection of the TWO paths that create records,
 * because both write through `writeRecord` and neither backfills defaults
 * (`pickMetaFields`/`pickContentFields`/`pickSummaryFields` copy only the keys
 * actually present, and `readRecord` merges the three docs as-is):
 *
 *   1. `createQueuedRecord` (pipeline kickoff) — populates every field below.
 *   2. Record import (`MSG.importRecords` in background.js, and
 *      `normalizeImportedRecords` in options) — spreads a user-supplied JSON
 *      object that only had to satisfy `isImportableRecord`, then overrides
 *      `key`, `status`, `error`, `progress` and `pipelineRunId`.
 *
 * So a field is REQUIRED only if path 2 also guarantees it. Fields that path 1
 * always sets but an imported record can lack are marked optional — consumers
 * that assume otherwise (e.g. `record.sentences.length`) can throw on an
 * imported record today.
 *
 * @typedef {Object} ArticleRecord
 * @property {string} key - Content-hash-derived id; primary storage key.
 * @property {string} html - Raw captured HTML. Required non-empty by
 *   `isImportableRecord`.
 * @property {string} status - One of the `PIPELINE_STATUS` values.
 * @property {string|null} error - Human-readable failure message, or null.
 * @property {{stage: string, done: number, total: number}} progress -
 *   Current pipeline progress; `stage` is one of the `PIPELINE_STAGE` values.
 * @property {string} pipelineRunId - Id of the run currently allowed to
 *   write this record; guards against stale/superseded runs.
 * @property {string} [sourceUrl] - Origin URL of the captured page ('' if none).
 * @property {string} [text] - Cleaned article text extracted from `html`.
 * @property {string[]} [sentences] - Sentence-split article text.
 * @property {object[]} [topics] - Detected topic ranges over `sentences`.
 * @property {Record<string, object>} [topic_summaries] - Resumable per-topic
 *   summary checkpoint, keyed by topic id. Entries may nest
 *   `start_sentence`/`end_sentence` chunk bounds (snake_case; see
 *   `worker/pipeline/sourceSummarizer.js`).
 * @property {Record<string, {level: number}>} [topic_summary_index] -
 *   Canonical UI projection of `topic_summaries`. Tolerated absent/null by
 *   `isImportableRecord`.
 * @property {object[]} [processingLog] - Buffered diagnostic log entries
 *   (capped; see `MAX_PROCESSING_LOG_ENTRIES` in storage.js).
 * @property {string[]} [selectors] - CSS selectors used to capture the page.
 * @property {boolean} [skipSummaries] - Run directive: summaries disabled for
 *   this run (decided at kickoff from the global toggle).
 * @property {boolean} [summariesDisabled] - Outcome flag: the run finished
 *   intentionally without summaries (distinct from `skipSummaries`, the
 *   directive).
 * @property {object[]} [summaryErrors] - Per-topic summary failures parked
 *   for user review (`PIPELINE_STATUS.NEEDS_ATTENTION`).
 * @property {boolean} [forceFinalize] - Run directive: finalize/merge even if
 *   some leaf summaries errored or are missing.
 * @property {string} [contentRevision] - Opaque id bumped whenever
 *   html/text/sentences/topics change; used to invalidate cached chats.
 * @property {number} [createdAt] - Epoch ms when the record was first queued.
 * @property {number} [updatedAt] - Epoch ms of the most recent write.
 */

/**
 * Creates the canonical initial record used when a new submission is queued.
 * The result is intentionally a serializable object, not a class instance.
 *
 * @param {{
 *   key: string,
 *   html: string,
 *   sourceUrl?: string,
 *   selectors?: string[],
 *   pipelineRunId: string,
 *   skipSummaries?: boolean,
 *   now?: number,
 * }} input
 */
export function createQueuedRecord({
  key,
  html,
  sourceUrl = '',
  selectors = [],
  pipelineRunId,
  skipSummaries = false,
  now = Date.now(),
}) {
  return {
    key,
    sourceUrl,
    html,
    text: '',
    status: PIPELINE_STATUS.PENDING,
    error: null,
    progress: {
      stage: PIPELINE_STAGE.QUEUED,
      done: 0,
      total: 0,
    },
    sentences: [],
    topics: [],
    topic_summaries: {},
    topic_summary_index: {},
    processingLog: [],
    selectors: Array.isArray(selectors) ? selectors : [],
    pipelineRunId,
    skipSummaries,
    createdAt: now,
    updatedAt: now,
  };
}
