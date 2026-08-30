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
  TOPIC_RANGES: 'topic_ranges',
  SUMMARIZING: 'summarizing',
  SUMMARIZING_TOPICS: 'summarizing_topics',
  MERGING_SUMMARIES: 'merging_summaries',
  NEEDS_ATTENTION: 'needs_attention',
  DONE: 'done',
  CANCELLED: 'cancelled',
  IMPORTED: 'imported',
});

export const IN_FLIGHT_PIPELINE_STATUSES = Object.freeze([
  PIPELINE_STATUS.PENDING,
  PIPELINE_STATUS.SPLITTING,
  PIPELINE_STATUS.SUMMARIZING,
]);
const IN_FLIGHT_PIPELINE_STATUS_VALUES = new Set(IN_FLIGHT_PIPELINE_STATUSES);

// Terminal checkpoints from which the summaries-only action may safely mint a
// replacement run. `needs_attention` has its own Retry/Skip resolution path.
export const SUMMARY_GENERATION_SOURCE_STATUSES = Object.freeze([
  PIPELINE_STATUS.DONE,
  PIPELINE_STATUS.CANCELLED,
  PIPELINE_STATUS.ERROR,
]);
const SUMMARY_GENERATION_SOURCE_STATUS_VALUES = new Set(SUMMARY_GENERATION_SOURCE_STATUSES);

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
export function isInFlightPipelineStatus(value) {
  return IN_FLIGHT_PIPELINE_STATUS_VALUES.has(value);
}

/** @param {unknown} value @returns {boolean} */
export function isSummaryGenerationSourceStatus(value) {
  return SUMMARY_GENERATION_SOURCE_STATUS_VALUES.has(value);
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
 * @property {string} [text] - Normalized article text. Capture v2 derives it
 *   from `capturedText`; legacy records derive it from `html`.
 * @property {string[]} [sentences] - Sentence-split article text.
 * @property {object[]} [topics] - Detected topic ranges over `sentences`.
 *   Newly computed topics carry `offset_basis: "captured_text"|"html"` to
 *   identify what their persisted `start`/`end` offsets index.
 * @property {object|null} [topic_range_chunks] - Resumable checkpoint for the
 *   topic-ranges stage: `{contentRevision, sentenceCount, chunks}` where
 *   `chunks[i]` is either null (that chunk still needs an LLM request) or
 *   `{start, sentenceCount, segments}` holding the already-parsed, article-
 *   absolute segments for chunk `i`. Updated after successful parse rounds
 *   and cleared when the stage succeeds, so a Retry re-requests only chunks
 *   that never landed. Validated structurally on read (see
 *   `readTopicRangeChunkCheckpoint` in `worker/pipeline/topicRangeCheckpoint.js`)
 *   and discarded whole unless `contentRevision` still matches, since an
 *   imported record can carry an arbitrary user-supplied value here.
 * @property {Record<string, object>} [topic_summaries] - Resumable per-topic
 *   summary checkpoint, keyed by topic id and containing per-run results. An
 *   entry may carry
 *   `forcedEmpty: true`, meaning the user accepted a failed topic via "skip"
 *   and finalization cleared its in-flight `error` marker — it distinguishes
 *   that case from a legitimately empty summary so `planSummaryWork`
 *   (`worker/pipeline/summaryPlanning.js`) can still retry it on a resume.
 *   An entry may also carry `acceptedFailure: true`, the transient counterpart
 *   written by the "skip" handler (`clearSummaryErrorFlags` in background.js)
 *   in place of the error fields it strips: it tells the resumed run the leaf
 *   is an accepted failure — so ancestor summaries skip its source and
 *   finalization stamps `forcedEmpty` — without making `planSummaryWork`
 *   re-query it. Finalization never persists it, so it only ever exists on a
 *   record between the skip decision and the end of the resumed run.
 * @property {Record<string, {level: number}>} [topic_summary_index] -
 *   Canonical UI projection of `topic_summaries`. Tolerated absent/null by
 *   `isImportableRecord`.
 * @property {Record<string, object>} [source_summary_units] - Optional
 *   resumable source-summary units keyed by stable request-kind/path/run/chunk
 *   bounds. A unit is reusable only when it is marked `done`, carries a
 *   non-empty matching `contentRevision`, and its input fingerprint matches
 *   the current source/prompt/settings input. Legacy/imported records may
 *   omit this field.
 * @property {object[]} [processingLog] - Buffered diagnostic log entries
 *   (capped; see `MAX_PROCESSING_LOG_ENTRIES` in storage.js).
 * @property {string[]} [selectors] - CSS selectors used to capture the page.
 * @property {number|null} [captureVersion] - Browser-side capture schema version.
 * @property {string|null} [capturedText] - Text extracted while source CSS/layout was available.
 * @property {boolean} [skipSummaries] - Run directive: summaries disabled for
 *   this run (decided at kickoff from the global toggle).
 * @property {boolean} [summariesDisabled] - Outcome flag: summary generation
 *   was disabled and the record has no summaries. Distinct from
 *   `skipSummaries`, the run directive.
 * @property {boolean} [summariesIncomplete] - Outcome flag: summary generation
 *   ran, but one or more failed summaries were accepted as empty. Consumers
 *   use it to offer a targeted regeneration without hiding successful
 *   summaries.
 * @property {object[]} [summaryErrors] - Per-topic summary failures parked
 *   for user review (`PIPELINE_STATUS.NEEDS_ATTENTION`).
 * @property {boolean} [forceFinalize] - Transient skip directive: finalize the
 *   failures identified by accepted leaf/merge markers. New failures raised
 *   during the resumed run still park for review.
 * @property {string[]} [acceptedMergeFailurePaths] - Transient paths of
 *   tree-merge failures accepted via "skip". The resumed run preserves their
 *   empty result without repeating the failed source-summary request.
 * @property {string} [contentRevision] - Opaque id bumped whenever
 *   html/text/sentences/topics change; used to invalidate cached chats.
 * @property {string|null} [summaryCheckpointContentRevision] - Content
 *   revision whose sentence/topic data reached the summarization stage. Retry
 *   only resumes a summary checkpoint when this matches `contentRevision`.
 * @property {boolean|null} [summaryCheckpointPreferContentLanguage] - Language
 *   preference captured when the topic checkpoint was created. Summary-only
 *   resumes retain it so reused and newly generated summaries follow one
 *   language policy.
 * @property {number} [createdAt] - Epoch ms when the record was first queued.
 * @property {number} [updatedAt] - Epoch ms of the most recent write.
 */

/**
 * Creates the canonical initial record used when a new submission is queued.
 * The result is intentionally a serializable object, not a class instance.
 *
 * @param {object} input
 * @param {string} input.key
 * @param {string} input.html
 * @param {string} [input.sourceUrl]
 * @param {string[]} [input.selectors]
 * @param {number} [input.captureVersion]
 * @param {string} [input.capturedText]
 * @param {string} input.pipelineRunId
 * @param {boolean} [input.skipSummaries]
 * @param {number} [input.now]
 */
export function createQueuedRecord({
  key,
  html,
  sourceUrl = '',
  selectors = [],
  captureVersion,
  capturedText,
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
    source_summary_units: {},
    processingLog: [],
    selectors: Array.isArray(selectors) ? selectors : [],
    captureVersion: Number.isInteger(captureVersion) ? captureVersion : null,
    capturedText: typeof capturedText === 'string' ? capturedText : null,
    pipelineRunId,
    skipSummaries,
    summaryCheckpointContentRevision: null,
    summaryCheckpointPreferContentLanguage: null,
    createdAt: now,
    updatedAt: now,
  };
}
