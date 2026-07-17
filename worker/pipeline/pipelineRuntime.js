import { appendProcessingLog, flushProcessingLog, readRecord, updateRecord } from '../storage/storage.js';

/**
 * Creates the storage/logging boundary shared by all pipeline stages. The
 * runtime owns cancellation checks and the expected pipeline-run id so stage
 * modules cannot accidentally persist work for a superseded run.
 *
 * @param {{key: string, pipelineRunId?: string, signal?: AbortSignal, preferContentLanguage?: boolean, verboseLogs?: boolean, summariesDisabled?: boolean}} context
 */
export function createPipelineRuntime(context) {
  const runtime = {
    ...context,

    assertActive() {
      if (runtime.signal?.aborted) {
        const err = new Error('Pipeline run was cancelled');
        err.name = 'AbortError';
        throw err;
      }
    },

    async read() {
      runtime.assertActive();
      return await readRecord(runtime.key);
    },

    async update(patch) {
      runtime.assertActive();
      const updated = await updateRecord(runtime.key, patch, {
        expectedPipelineRunId: runtime.pipelineRunId,
      });
      if (!updated) {
        const err = new Error('Pipeline run is no longer current');
        err.name = 'AbortError';
        throw err;
      }
      return updated;
    },

    /**
     * Lifecycle and error stages always record. Verbose stages only record when
     * verbose logging was enabled when this run started.
     */
    async log(stage, details = {}, options = {}) {
      if (options.verbose && !runtime.verboseLogs) return;
      console.info('PageToLLM Canvas pipeline:', stage, details);
      runtime.assertActive();
      // Logging is buffered, so persistence intentionally does not serialize
      // pipeline progress behind it. The final flush happens in runPipeline.
      appendProcessingLog(runtime.key, stage, details, {
        expectedPipelineRunId: runtime.pipelineRunId,
      }).catch((err) => {
        console.warn('PageToLLM Canvas pipeline log failed:', err);
      });
    },

    async flushLogs() {
      await flushProcessingLog(runtime.key).catch(() => {});
    },
  };

  return runtime;
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
