import {
  appendProcessingLog,
  flushProcessingLog,
  putSourceSummaryUnit,
  putTopicSummaryCheckpoint,
  readRecord,
  SOURCE_SUMMARY_UNIT_REVISION_MISMATCH,
  updateRecord,
} from '../storage/storage.js';
import { markCancellation } from './cancellation.js';
import { createLogger } from '../../src/shared/runtime/log.js';
import { MAX_TAGGED_CHARS, TOPIC_RANGE_INPUT_MAX_SENTENCES } from './pipelineConfig.js';

const logger = createLogger('pipeline');

/**
 * @typedef {Object} PipelineRuntimeContext
 * @property {string} key
 * @property {string} [pipelineRunId]
 * @property {AbortSignal} [signal]
 * @property {boolean} [preferContentLanguage]
 * @property {boolean} [verboseLogs]
 * @property {boolean} [summariesDisabled]
 * @property {number} [maxTextChunkChars]
 * @property {number} [maxTopicRangeSentences]
 */

/**
 * @typedef {Object} PipelineRuntime
 * @property {string} key
 * @property {string|undefined} pipelineRunId
 * @property {AbortSignal|undefined} signal
 * @property {boolean|undefined} preferContentLanguage
 * @property {boolean|undefined} verboseLogs
 * @property {boolean} summariesDisabled
 * @property {number} maxTextChunkChars
 * @property {number} maxTopicRangeSentences
 * @property {function(): void} assertActive
 * @property {function(): Promise<object|null>} read
 * @property {function(object, object=): Promise<object>} update
 * @property {function(string, object): Promise<object>} checkpointTopicSummary
 * @property {function(object): Promise<object>} checkpointSourceSummaryUnit
 * @property {function(boolean): void} setSummariesDisabled
 * @property {function(string, object, object=): Promise<void>} log
 * @property {function(): Promise<void>} flushLogs
 */

/**
 * Creates the storage/logging boundary shared by all pipeline stages. The
 * runtime owns cancellation checks and the expected pipeline-run id so stage
 * modules cannot accidentally persist work for a superseded run.
 *
 * @param {PipelineRuntimeContext} context
 * @returns {PipelineRuntime}
 */
export function createPipelineRuntime({
  key,
  pipelineRunId,
  signal,
  preferContentLanguage,
  verboseLogs,
  summariesDisabled = false,
  maxTextChunkChars = MAX_TAGGED_CHARS,
  maxTopicRangeSentences = TOPIC_RANGE_INPUT_MAX_SENTENCES,
}) {
  const runtime = {
    key,
    pipelineRunId,
    signal,
    preferContentLanguage,
    verboseLogs,
    summariesDisabled,
    maxTextChunkChars,
    maxTopicRangeSentences,

    assertActive() {
      if (runtime.signal?.aborted) {
        const err = new Error('Pipeline run was cancelled');
        err.name = 'AbortError';
        throw markCancellation(err);
      }
    },

    async read() {
      runtime.assertActive();
      return await readRecord(runtime.key);
    },

    async update(patch, options = {}) {
      // Failure persistence may race an external abort. The run-id CAS still
      // prevents a cancelled/superseded job from overwriting its successor,
      // while allowing an unrelated failure to be saved when this run remains
      // current.
      if (!options.allowAborted) runtime.assertActive();
      const updated = await updateRecord(runtime.key, patch, {
        expectedPipelineRunId: runtime.pipelineRunId,
      });
      if (!updated) {
        // Losing the CAS means a newer run owns the record. That is a
        // cancellation for this run even though nothing aborted its signal, so
        // it is marked explicitly rather than relying on the AbortError name.
        const err = new Error('Pipeline run is no longer current');
        err.name = 'AbortError';
        throw markCancellation(err);
      }
      return updated;
    },

    async checkpointTopicSummary(topicPath, summary) {
      runtime.assertActive();
      const persisted = await putTopicSummaryCheckpoint(runtime.key, topicPath, summary, {
        expectedPipelineRunId: runtime.pipelineRunId,
      });
      if (!persisted) throwLostRun();
      return persisted;
    },

    async checkpointSourceSummaryUnit(unit) {
      runtime.assertActive();
      const persisted = await putSourceSummaryUnit(runtime.key, unit, {
        expectedPipelineRunId: runtime.pipelineRunId,
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

    setSummariesDisabled(disabled) {
      runtime.summariesDisabled = disabled === true;
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
      if (options.verbose && !runtime.verboseLogs) return;
      logger.event(stage, details);
      if (!options.allowAborted) runtime.assertActive();
      // Logging is buffered, so persistence intentionally does not serialize
      // pipeline progress behind it. The final flush happens in runPipeline.
      appendProcessingLog(runtime.key, stage, details, {
        expectedPipelineRunId: runtime.pipelineRunId,
      }).catch((err) => {
        logger.warn('log failed:', err);
      });
    },

    async flushLogs() {
      // Best-effort like the buffered append above: a failed flush must not
      // mask the pipeline error this is usually called alongside. It does need
      // a signal though — the lost buffer is the diagnostic trail explaining
      // that very failure.
      await flushProcessingLog(runtime.key).catch((err) => {
        logger.warn('log flush failed:', err);
      });
    },
  };

  return runtime;
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
  const message = (error && error.message) || String(error);
  const stack = typeof error?.stack === 'string' ? error.stack : '';
  if (!stack) return message;
  return stack.includes(message) ? stack : `${message}\n${stack}`;
}
