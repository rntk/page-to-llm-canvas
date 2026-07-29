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
    typeof record.html === 'string'
  );
}

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
