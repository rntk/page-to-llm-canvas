import { errorMessage } from '../../../shared/runtime/errorMessage.js';
import {
  appendProcessingLog,
  flushProcessingLog,
  putSourceSummaryUnit,
  putTopicSummaryCheckpoint,
  readRecord,
  SOURCE_SUMMARY_UNIT_REVISION_MISMATCH,
  updateRecord,
} from '../../../core/storage/storage.js';
import { markCancellation } from '../../../core/pipeline/cancellation.js';
import { createLogger } from '../../../shared/runtime/log.js';
import {
  MAX_TAGGED_CHARS,
  TOPIC_RANGE_INPUT_MAX_SENTENCES,
} from '../../../core/pipeline/pipelineConfig.js';
import { DEFAULT_DECISION_SPLIT_THRESHOLD } from '../../../core/settings/decisionThreshold.js';
import { PIPELINE_STATUS } from '../../../shared/runtime/contracts.js';

const logger = createLogger('pipeline');

/**
 * @typedef {Object} PipelineRuntimeContext
 * @property {string} key
 * @property {string} [pipelineRunId]
 * @property {AbortSignal} [signal]
 * @property {boolean} [preferContentLanguage]
 * @property {string} [splittingInstructions]
 * @property {string} [summaryInstructions]
 * @property {boolean} [verboseLogs]
 * @property {boolean} [summariesDisabled]
 * @property {number} [decisionSplitThreshold]
 * @property {number} [maxTextChunkChars]
 * @property {number} [maxTopicRangeSentences]
 */

/**
 * Frozen: identity and stage settings are fixed for the runtime's lifetime.
 * Settings resolved later in a run require a new runtime.
 *
 * @typedef {Object} PipelineRuntime
 * @property {string} key
 * @property {string|undefined} pipelineRunId
 * @property {AbortSignal|undefined} signal
 * @property {boolean|undefined} preferContentLanguage
 * @property {string} [splittingInstructions]
 * @property {string} [summaryInstructions]
 * @property {boolean|undefined} verboseLogs
 * @property {boolean} summariesDisabled
 * @property {number} decisionSplitThreshold
 * @property {number} maxTextChunkChars
 * @property {number} maxTopicRangeSentences
 * @property {function(): void} assertActive
 * @property {function(): Promise<object|null>} read
 * @property {function(object, object=): Promise<object>} update
 * @property {function(string, object): Promise<object>} checkpointTopicSummary
 * @property {function(object): Promise<object>} checkpointSourceSummaryUnit
 * @property {function(object, object=): Promise<object>} saveSummaryTree
 * @property {function(object, object=): Promise<object>} saveQuestionTree
 * @property {function(string, object, object=): Promise<void>} log
 * @property {function(): Promise<void>} flushLogs
 */

/**
 * Creates the storage/logging boundary shared by all pipeline stages. The
 * runtime owns cancellation checks and the expected pipeline-run id so stage
 * modules cannot accidentally persist work for a superseded run. Methods use
 * the identity captured at construction and the returned object is frozen, so
 * neither guarded writes nor stage settings can be redirected mid-run.
 *
 * @param {PipelineRuntimeContext} context
 * @returns {Readonly<PipelineRuntime>}
 */
export function createPipelineRuntime({
  key,
  pipelineRunId,
  signal,
  preferContentLanguage,
  splittingInstructions,
  summaryInstructions,
  verboseLogs,
  summariesDisabled = false,
  decisionSplitThreshold = DEFAULT_DECISION_SPLIT_THRESHOLD,
  maxTextChunkChars = MAX_TAGGED_CHARS,
  maxTopicRangeSentences = TOPIC_RANGE_INPUT_MAX_SENTENCES,
}) {
  function assertActive() {
    if (signal?.aborted) {
      const err = new Error('Pipeline run was cancelled');
      err.name = 'AbortError';
      throw markCancellation(err);
    }
  }

  return Object.freeze({
    key,
    pipelineRunId,
    signal,
    preferContentLanguage,
    splittingInstructions,
    summaryInstructions,
    verboseLogs,
    summariesDisabled: summariesDisabled === true,
    decisionSplitThreshold,
    maxTextChunkChars,
    maxTopicRangeSentences,

    assertActive,

    async read() {
      assertActive();
      return await readRecord(key);
    },

    async update(patch, options = {}) {
      // Failure writes may race an abort; the run-id CAS still stops a
      // superseded job from overwriting its successor.
      if (!options.allowAborted) assertActive();
      const updated = await updateRecord(key, patch, {
        expectedPipelineRunId: pipelineRunId,
        // Lets a failure write refuse to relabel an already-terminal record.
        ...(options.expectedStatuses ? { expectedStatuses: options.expectedStatuses } : {}),
      });
      // Losing the CAS means a newer run owns the record: a cancellation even
      // though the signal never aborted, so mark it explicitly.
      if (!updated) throwLostRun();
      return updated;
    },

    async checkpointTopicSummary(topicPath, summary) {
      assertActive();
      const persisted = await putTopicSummaryCheckpoint(key, topicPath, summary, {
        expectedPipelineRunId: pipelineRunId,
      });
      if (!persisted) throwLostRun();
      return persisted;
    },

    async checkpointSourceSummaryUnit(unit) {
      assertActive();
      const persisted = await putSourceSummaryUnit(key, unit, {
        expectedPipelineRunId: pipelineRunId,
      });
      if (persisted === SOURCE_SUMMARY_UNIT_REVISION_MISMATCH) {
        // The provider result is still valid for this run; only the optional
        // cache entry lost a narrow revision race. Do not abandon the rest of
        // the summary pipeline over a failed cache write.
        logger.warn('source summary cache checkpoint skipped after a content revision race');
        return unit;
      }
      if (!persisted) throwLostRun();
      return persisted;
    },

    /**
     * Saves the summary tree beside a completed record's topics. The record
     * must stay completed and owned by this run; any other run supersedes it.
     * @param {object} tree `summary_tree` snapshot.
     * @param {object} [options]
     * @param {boolean} [options.allowAborted] Persist a failure after an abort.
     */
    async saveSummaryTree(tree, options = {}) {
      if (!options.allowAborted) assertActive();
      const updated = await updateRecord(
        key,
        { summary_tree: tree },
        {
          expectedPipelineRunId: pipelineRunId,
          expectedStatuses: [PIPELINE_STATUS.DONE],
        },
      );
      if (!updated) throwLostRun();
      return updated;
    },

    /**
     * Saves the question tree beside a completed record's topics.
     * @param {object} tree `question_tree` snapshot.
     * @param {object} [options]
     * @param {boolean} [options.allowAborted] Persist a failure after an abort.
     */
    async saveQuestionTree(tree, options = {}) {
      if (!options.allowAborted) assertActive();
      const updated = await updateRecord(
        key,
        { question_tree: tree },
        {
          expectedPipelineRunId: pipelineRunId,
          expectedStatuses: [PIPELINE_STATUS.DONE],
        },
      );
      if (!updated) throwLostRun();
      return updated;
    },

    /**
     * Lifecycle and error stages always record. Verbose stages only record when
     * verbose logging was enabled when this run started.
     * @param {string} stage Pipeline stage name.
     * @param {object} [details] Diagnostic details.
     * @param {object} [options] Logging options.
     * @param {boolean} [options.verbose]
     * @param {boolean} [options.allowAborted]
     */
    async log(stage, details = {}, options = {}) {
      if (options.verbose && !verboseLogs) return;
      logger.event(stage, details);
      if (!options.allowAborted) assertActive();
      // Buffered: progress is not serialized behind persistence. runPipeline flushes at the end.
      appendProcessingLog(key, stage, details, {
        expectedPipelineRunId: pipelineRunId,
      }).catch((err) => {
        logger.warn('log failed:', err);
      });
    },

    async flushLogs() {
      // Best-effort: must not mask the pipeline error it accompanies, but is
      // warned since the lost buffer is the trail explaining that failure.
      await flushProcessingLog(key).catch((err) => {
        logger.warn('log flush failed:', err);
      });
    },
  });
}

function throwLostRun() {
  const err = new Error('Pipeline run is no longer current');
  err.name = 'AbortError';
  throw markCancellation(err);
}

/**
 * Formats an error for storage/display while preserving the message on
 * browsers whose Error#stack contains only stack frames.
 *
 * @param {unknown} error
 * @returns {string}
 */
export function formatPipelineError(error) {
  if (error == null) return 'Unknown error';
  const message = errorMessage(error);
  const stack = typeof error?.stack === 'string' ? error.stack : '';
  if (!stack) return message;
  return stack.includes(message) ? stack : `${message}\n${stack}`;
}
