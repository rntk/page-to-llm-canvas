// Shared builders for the record patches that move a record between pipeline
// states. Handlers and stages used to assemble `status` / `progress` / reset
// bundles by hand, which made it easy for one site to drift from the others
// (a resume forgetting to clear `summariesIncomplete`, a reset leaving a stale
// checkpoint revision behind). Every transition now goes through one of these
// so the field bundles that must change together are defined once.
//
// These only build the patch. Ownership is still enforced at the repository:
// callers pass `expectedPipelineRunId` / `expectedStatuses` to `updateRecord`
// and storage's `isStaleRun` decides whether the write lands.
import { PIPELINE_STAGE, PIPELINE_STATUS } from './contracts.js';

/**
 * @param {string} stage One of `PIPELINE_STAGE`.
 * @param {number} [done]
 * @param {number} [total]
 */
export function progressAt(stage, done = 0, total = 0) {
  return { stage, done, total };
}

/**
 * Clears the per-run review state produced by a parked (`needs_attention`)
 * run: the reported errors and the Retry/Skip directives derived from them.
 */
export function resetSummaryReviewPatch() {
  return {
    summaryErrors: [],
    forceFinalize: false,
    acceptedMergeFailurePaths: [],
    summariesIncomplete: false,
  };
}

/**
 * Drops the resumable summary checkpoint (topics, summaries, and the revision
 * markers that let Retry trust them) along with the review state built on it.
 * Sentences/text are left alone; use `resetContentCheckpointPatch` when the
 * source content itself is being replaced.
 */
export function resetSummaryCheckpointPatch() {
  return {
    manualResplitIntent: null,
    resplitNotice: null,
    topics: [],
    topic_summaries: {},
    topic_summary_index: {},
    source_summary_units: {},
    ...resetSummaryReviewPatch(),
    summaryCheckpointContentRevision: null,
    summaryCheckpointPreferContentLanguage: null,
  };
}

/**
 * Full derived-content reset for a run that will rebuild everything from the
 * captured HTML (submit over an existing record, reprocess).
 */
export function resetContentCheckpointPatch() {
  return {
    ...resetSummaryCheckpointPatch(),
    sentences: [],
    text: '',
  };
}

/** A fresh run waiting for the orchestrator to pick it up. */
export function queuedTransition() {
  return {
    status: PIPELINE_STATUS.PENDING,
    error: null,
    progress: progressAt(PIPELINE_STAGE.QUEUED),
  };
}

/** Entering the clean/split/topic-ranges stage. */
export function splittingTransition() {
  return {
    status: PIPELINE_STATUS.SPLITTING,
    error: null,
    progress: progressAt(PIPELINE_STAGE.NORMALIZING_TEXT),
  };
}

/**
 * Entering (or resuming) topic summarization.
 * @param {object} [options]
 * @param {number} [options.total] Topic count shown by the progress counter.
 * @param {boolean} [options.clearError=true] Set `false` when the caller has
 *   already cleared `error` in an earlier write of the same run.
 */
export function summarizingTransition({ total = 0, clearError = true } = {}) {
  return {
    status: PIPELINE_STATUS.SUMMARIZING,
    ...(clearError ? { error: null } : {}),
    progress: progressAt(PIPELINE_STAGE.SUMMARIZING_TOPICS, 0, total),
  };
}

/**
 * Resuming a saved summary checkpoint. Every resume path clears the previous
 * run's errors and incomplete marker; the Retry/Skip directives are supplied
 * by the caller because they differ per action.
 * @param {object} options
 * @param {number} options.total
 * @param {boolean} [options.forceFinalize=false]
 * @param {string[]} [options.acceptedMergeFailurePaths=[]]
 */
export function resumeSummariesTransition({
  total,
  forceFinalize = false,
  acceptedMergeFailurePaths = [],
}) {
  return {
    ...summarizingTransition({ total }),
    summaryErrors: [],
    forceFinalize,
    acceptedMergeFailurePaths,
    summariesIncomplete: false,
  };
}

/**
 * Parking a run for user review of failed summaries.
 * @param {object[]} summaryErrors
 * @param {{done: number, total: number}} progress
 */
export function needsAttentionTransition(summaryErrors, { done = 0, total = 0 } = {}) {
  return {
    status: PIPELINE_STATUS.NEEDS_ATTENTION,
    summaryErrors,
    forceFinalize: false,
    summariesIncomplete: false,
    progress: progressAt(PIPELINE_STAGE.NEEDS_ATTENTION, done, total),
  };
}

/**
 * Terminal success. Review state is cleared because nothing is left to review;
 * `summariesIncomplete` is a caller decision (accepted failures survive into a
 * done record as retryable empties).
 * @param {object} options
 * @param {number} options.done
 * @param {number} options.total
 * @param {boolean} options.summariesDisabled Required: whether this run skipped
 *   summaries. No default on purpose — a caller that omits it has made a
 *   decision it did not mean to make.
 * @param {boolean} [options.summariesIncomplete=false]
 */
export function doneTransition({
  done = 0,
  total = 0,
  summariesDisabled,
  summariesIncomplete = false,
}) {
  return {
    status: PIPELINE_STATUS.DONE,
    summariesDisabled,
    summariesIncomplete,
    progress: progressAt(PIPELINE_STAGE.DONE, done, total),
    summaryErrors: [],
    forceFinalize: false,
    acceptedMergeFailurePaths: [],
  };
}

export const RESPLIT_NO_CHANGE_NOTICE =
  'Resplit returned the same topics; the topic was left unchanged.';
export const RESPLIT_CANCELLED_NOTICE = 'Resplit stopped; the topic was left unchanged.';

/**
 * Ends a manual resplit that did not replace any topics (no change, failure,
 * or Stop) by returning the record to the completed state it was in before
 * the Resplit action. Nothing in the topic checkpoint was modified, so the
 * record is still fully usable; `notice` tells the user what happened.
 * @param {object} record Record snapshot still holding `manualResplitIntent`.
 * @param {string} notice User-facing outcome.
 */
export function restoreAfterResplitPatch(record, notice) {
  const topicCount = Array.isArray(record?.topics) ? record.topics.length : 0;
  return {
    manualResplitIntent: null,
    resplitNotice: notice,
    status: PIPELINE_STATUS.DONE,
    error: null,
    progress:
      record?.manualResplitIntent?.previousProgress ||
      progressAt(PIPELINE_STAGE.DONE, topicCount, topicCount),
  };
}

/** User-initiated stop of an in-flight run. */
export function cancelledTransition() {
  return {
    status: PIPELINE_STATUS.CANCELLED,
    error: 'Processing stopped.',
    summariesIncomplete: false,
    progress: progressAt(PIPELINE_STAGE.CANCELLED),
  };
}

/**
 * Terminal failure. Progress is deliberately left where the run stopped so
 * the UI can show which stage failed.
 * @param {string} error Formatted error text.
 */
export function errorTransition(error) {
  return { status: PIPELINE_STATUS.ERROR, error };
}
