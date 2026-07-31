// Pipeline entry point: clean HTML, split sentences, find topic ranges, and
// generate per-topic summaries. This runs in the service-worker context.

import { callLLMWithRetry as callLLMWithRetryRaw, createAdjustableLimiter } from '../llm/llm.js';
import { wrapCallLLMWithRetry } from '../metrics/llm.js';
import {
  DEFAULT_MAX_PARALLEL_LLM_REQUESTS,
  MAX_PARALLEL_LLM_REQUESTS_KEY,
  getStoredMaxParallelLlmRequests,
  normalizeMaxParallelLlmRequests,
} from '../settings/llmConcurrency.js';
import { getStoredPreferContentLanguage } from '../settings/language.js';
import { getStoredVerboseLogs } from '../settings/verboseLog.js';
import { createPipelineRuntime, formatPipelineError } from './pipelineRuntime.js';
import { computeTopics } from './topicRangesStage.js';
import { finalizeSummariesDisabled, runSummaries } from './summaryStage.js';
import { PIPELINE_STAGE, PIPELINE_STATUS } from '../../src/shared/runtime/contracts.js';

// All concurrently running page pipelines share this provider-facing boundary.
// Internal stage caps still control their own fan-out, while this outer queue
// prevents those caps from multiplying when many pages are submitted together.
const pipelineLlmLimiter = createAdjustableLimiter(DEFAULT_MAX_PARALLEL_LLM_REQUESTS);
const measuredCallLLMWithRetry = wrapCallLLMWithRetry(callLLMWithRetryRaw);
// The limiter slot is held for the entire retry loop, including its backoff
// sleeps, not just the in-flight HTTP call. Releasing the slot between
// attempts would let a replacement request take it and hit the same
// failing/rate-limited provider while the original request is still backing
// off, defeating the point of backoff. Pass the caller's signal through so a
// queued (not-yet-started) call can be cancelled without waiting for a slot.
const callLLMWithRetry = (opts, maxRetries) =>
  pipelineLlmLimiter.run(() => measuredCallLLMWithRetry(opts, maxRetries), opts?.signal);
let concurrencySettingRevision = 0;

try {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes?.[MAX_PARALLEL_LLM_REQUESTS_KEY]) return;
    concurrencySettingRevision++;
    pipelineLlmLimiter.setLimit(
      normalizeMaxParallelLlmRequests(changes[MAX_PARALLEL_LLM_REQUESTS_KEY].newValue),
    );
  });
} catch (_) {
  /* The stored value is still loaded whenever a pipeline starts. */
}

/**
 * Runs or resumes the persisted article-processing pipeline.
 *
 * @param {string} key
 * @param {object} [options]
 * @param {string} [options.pipelineRunId]
 * @param {AbortSignal} [options.signal]
 */
export async function runPipeline(key, options = {}) {
  const concurrencyRevisionAtRead = concurrencySettingRevision;
  const [preferContentLanguage, verboseLogs, maxParallelLlmRequests] = await Promise.all([
    getStoredPreferContentLanguage(),
    getStoredVerboseLogs(),
    getStoredMaxParallelLlmRequests(),
  ]);
  if (concurrencySettingRevision === concurrencyRevisionAtRead) {
    pipelineLlmLimiter.setLimit(maxParallelLlmRequests);
  }

  const runtime = createPipelineRuntime({
    key,
    pipelineRunId: options.pipelineRunId,
    signal: options.signal,
    // Snapshot settings once so mid-run changes do not alter prompt or logging
    // behavior, including across service-worker resume calls.
    preferContentLanguage,
    verboseLogs,
    summariesDisabled: false,
  });

  try {
    await runtime.log('pipeline_start');
    const record = await runtime.read();
    if (!record) throw new Error(`record not found: ${key}`);
    runtime.setSummariesDisabled(record.skipSummaries === true);

    // A summarizing record has already persisted topics for its current HTML.
    // `topic_summaries` is the load-bearing leaf checkpoint used to resume or
    // retry incomplete summary work; UI consumers read `topic_summary_index`.
    // Reuse the checkpoint after service-worker recycling and fill only missing
    // summaries.
    const resuming =
      record.status === PIPELINE_STATUS.SUMMARIZING &&
      Array.isArray(record.topics) &&
      record.topics.length > 0;

    let topics;
    let sentenceTexts;
    if (resuming) {
      topics = record.topics;
      sentenceTexts = Array.isArray(record.sentences) ? record.sentences : [];
      const existingSummaries =
        record.topic_summaries && typeof record.topic_summaries === 'object'
          ? record.topic_summaries
          : {};
      await runtime.log('pipeline_resume', {
        stage: PIPELINE_STAGE.SUMMARIZING,
        topicCount: topics.length,
        existingSummaryCount: Object.keys(existingSummaries).length,
      });
      await runtime.update({ status: PIPELINE_STATUS.SUMMARIZING, error: null });
    } else {
      ({ topics, sentenceTexts } = await computeTopics({
        runtime,
        record,
        callLLMWithRetry,
      }));
      if (!topics) return;
    }

    if (runtime.summariesDisabled) {
      await finalizeSummariesDisabled(runtime, topics);
      return;
    }

    const previousSummaries =
      resuming && record.topic_summaries && typeof record.topic_summaries === 'object'
        ? record.topic_summaries
        : {};
    const forceFinalize = resuming && record.forceFinalize === true;
    await runSummaries({
      runtime,
      topics,
      sentenceTexts,
      previousSummaries,
      forceFinalize,
      callLLMWithRetry,
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      // A superseded run id or an external cancel lands here. We intentionally
      // leave the record's status alone (a newer run owns it), but log so these
      // exits are not completely invisible when diagnosing a stuck record.
      console.info('PageToLLM Canvas pipeline aborted:', key, (error && error.message) || error);
      return;
    }

    const formattedError = formatPipelineError(error);
    await runtime.log('pipeline_error', { error: formattedError });
    await runtime
      .update({ status: PIPELINE_STATUS.ERROR, error: formattedError })
      .catch((writeError) => {
        console.error('PageToLLM Canvas: failed to persist error status to storage:', writeError);
      });
    throw error;
  } finally {
    await runtime.flushLogs();
  }
}
