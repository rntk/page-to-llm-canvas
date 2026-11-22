// Browser-safe contracts shared by extension surfaces and the service worker.
// Describes the persisted/wire form: plain strings and objects only, so Chrome
// storage and messaging never depend on prototypes.

// Shared contract for generated and persisted chat turns.
export const MAX_TURN_EVENTS = 200;

export const RAIL_MODE = Object.freeze({
  TOPICS: 'topics',
  SUMMARIES: 'summaries',
  CHAT: 'chat',
});

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
  NORMALIZING_TEXT: 'normalizing_text',
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

// Display code throws on malformed levels, so reject bad indexes here to keep
// imported records viewable. Absent/null indexes from older exports are allowed.
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

/** @param {unknown} record @returns {boolean} */
export function isInFlightRecord(record) {
  return !!record && isInFlightPipelineStatus(record.status);
}

/** @param {unknown} value @returns {boolean} */
export function isSummaryGenerationSourceStatus(value) {
  return SUMMARY_GENERATION_SOURCE_STATUS_VALUES.has(value);
}

// Keep internal storage coordination names out of user-supplied imports.
const RESERVED_RECORD_KEYS = new Set(['pagetollm:mutation-queue', 'pagetollm:index']);

/**
 * Whether a record has enough article data to import. Shared by the options page
 * and service worker so both enforce the same minimum.
 *
 * @param {unknown} record
 * @returns {boolean}
 */
export function isImportableRecord(record) {
  if (!record || typeof record !== 'object') return false;
  if (typeof record.key !== 'string') return false;
  const key = record.key.trim();
  if (!key || RESERVED_RECORD_KEYS.has(key)) return false;
  if (typeof record.html !== 'string' || !record.html.trim()) return false;
  return isImportableTopicSummaryIndex(record.topic_summary_index);
}

/**
 * Persisted shape of a page record, written by `writeRecord` and reassembled on
 * read (see src/core/storage/storage.js). Field names mix camelCase and snake_case.
 *
 * A field is required only if both creation paths set it: `createQueuedRecord`
 * sets every field, while imported records (`decodeImportedRecords`) only have to
 * pass `isImportableRecord`. Fields an import can lack are optional. Processing
 * code must validate the stored record itself, not infer state from display
 * defaults such as `projectArticleView` (src/domain/articleView.js).
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
 * @property {string} [text] - Normalized article text derived from `capturedText`.
 * @property {string[]} [sentences] - Sentence-split article text.
 * @property {object[]} [topics] - Detected topic ranges over `sentences`,
 *   each containing `{ name: string, sentences: number[] }` where `sentences`
 *   is an ordered, 1-based unique list of sentence indices.
 * @property {object|null} [topic_range_chunks] - Resumable topic-ranges checkpoint
 *   `{contentRevision, sentenceCount, chunks}`; a null chunk still needs an LLM
 *   request. Cleared on success. Decision splitting stores `{mode: 'decision', ...}`
 *   in the same work document. Both variants are discarded unless `contentRevision`
 *   matches, since imported records can carry arbitrary values here. Validated by
 *   `readTopicRangeChunkCheckpoint` (src/core/pipeline/topicRangeCheckpoint.js).
 * @property {Record<string, object>} [topic_summaries] - Resumable per-path summary
 *   checkpoints keyed by topic id. `forcedEmpty: true` marks a failed topic the user
 *   skipped, so `planSummaryWork` (src/core/pipeline/summaryPlanning.js) still retries
 *   it on resume. `acceptedFailure: true` is a transient skip marker that finalization
 *   turns into `forcedEmpty` and never persists. Older records may hold mixed-depth paths.
 * @property {Record<string, {level: number}>} [topic_summary_index] -
 *   Canonical UI projection of every topic-tree path. Tolerated absent/null by
 *   `isImportableRecord`.
 * @property {Record<string, object>} [source_summary_units] - Optional resumable
 *   source-summary units keyed by request-kind/path/run/chunk bounds. Reusable only
 *   when `done`, with a matching non-empty `contentRevision` and input fingerprint.
 * @property {object[]} [processingLog] - Buffered diagnostic log entries
 *   (capped; see `MAX_PROCESSING_LOG_ENTRIES` in src/core/storage/processingLog.js).
 * @property {string[]} [selectors] - CSS selectors used to capture the page.
 * @property {number|null} [captureVersion] - Browser-side capture schema version.
 * @property {string|null} [capturedText] - Text extracted while source CSS/layout was available.
 * @property {{splittingInstructions: string, summaryInstructions: string}|null} [runInstructions] -
 *   Run directive: user guidance for this run only. Kept through resume and Retry,
 *   cleared when the run completes.
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
 * @property {string} [topicsRevision] - Opaque id changed when sentences, topics,
 *   topic_summary_index, sourceUrl or content generation change; invalidates cached
 *   topic views. Older records may lack it.
 * @property {string|null} [summaryCheckpointContentRevision] - Content
 *   revision whose sentence/topic data reached the summarization stage. Retry
 *   only resumes a summary checkpoint when this matches `contentRevision`.
 * @property {boolean|null} [summaryCheckpointPreferContentLanguage] - Language
 *   preference captured when the topic checkpoint was created; summary-only resumes
 *   keep it so all summaries follow one language policy.
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
 * @param {{splittingInstructions: string, summaryInstructions: string}|null} [input.runInstructions]
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
  runInstructions = null,
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
    runInstructions: runInstructions ?? null,
    summaryCheckpointContentRevision: null,
    summaryCheckpointPreferContentLanguage: null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Builds UI-only record projections from separately transported runtime state.
 * Persisted records and exports remain unchanged.
 * @param {object[]} records Persisted record projections.
 * @param {Record<string, object>} failures Runtime failures keyed by record key.
 * @returns {object[]}
 */
export function applyPipelineFailures(records, failures = {}) {
  return (Array.isArray(records) ? records : []).map((record) => {
    const failure = failures?.[record?.key];
    if (!failure) return record;
    return {
      ...record,
      status: PIPELINE_STATUS.ERROR,
      error: failure.message,
      pipelineFailure: failure,
    };
  });
}
