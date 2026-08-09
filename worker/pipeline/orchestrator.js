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
import { isCancellationError } from './cancellation.js';
import { PIPELINE_STAGE, PIPELINE_STATUS } from '../../src/shared/runtime/contracts.js';
import { createLogger } from '../../src/shared/runtime/log.js';

const log = createLogger();
const pipelineLog = createLogger('pipeline');

// A resumable checkpoint must carry the sentence texts its topics reference.
// If `sentences` is missing/short, out-of-range sentence ids get silently
// dropped and a blank summary can be finalized as "done". Refuse the
// checkpoint in place rather than recomputing topics, which would erase any
// valid summaries that survived a partial write.
//
// Two failure classes are handled differently. A structurally malformed
// topic — no usable nonblank string `name`, `sentences` not an array, or an
// out-of-range sentence id — refuses the WHOLE checkpoint even if other
// topics are healthy. A well-formed topic whose sentences resolve to blank
// source text is tolerated per topic; the checkpoint is refused only when NO
// topic can yield a summary.
export function isSummaryCheckpointComplete(record) {
  if (!Array.isArray(record?.topics) || record.topics.length === 0) return false;
  if (!Array.isArray(record.sentences) || record.sentences.length === 0) return false;
  const sentenceCount = record.sentences.length;
  const hasSourceText = (oneIdx) => {
    const text = record.sentences[oneIdx - 1];
    return typeof text === 'string' && text.trim() !== '';
  };

  let summarizableTopics = 0;
  for (const topic of record.topics) {
    if (typeof topic?.name !== 'string' || topic.name.trim() === '') return false;
    if (!Array.isArray(topic.sentences)) return false;
    if (
      !topic.sentences.every(
        (oneIdx) => Number.isInteger(oneIdx) && oneIdx >= 1 && oneIdx <= sentenceCount,
      )
    ) {
      return false;
    }
    if (topic.sentences.some(hasSourceText)) summarizableTopics++;
  }
  return summarizableTopics > 0;
}

// Shared provider-facing boundary across all running page pipelines, so
// per-stage concurrency caps don't multiply when many pages run together.
const pipelineLlmLimiter = createAdjustableLimiter(DEFAULT_MAX_PARALLEL_LLM_REQUESTS);
const measuredCallLLMWithRetry = wrapCallLLMWithRetry(callLLMWithRetryRaw);
// The limiter slot is held for the whole retry loop, including backoff sleeps,
// not just the HTTP call, so a replacement request can't hit the same
// failing/rate-limited provider mid-backoff. The signal is passed through so a
// queued call can still be cancelled without waiting for a slot.
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
    // Snapshot settings once so a mid-run change doesn't alter behavior.
    preferContentLanguage,
    verboseLogs,
    summariesDisabled: false,
  });

  try {
    await runtime.log('pipeline_start');
    const record = await runtime.read();
    if (!record) throw new Error(`record not found: ${key}`);
    runtime.setSummariesDisabled(record.skipSummaries === true);

    // `topic_summaries` is the leaf checkpoint used to resume/retry summary
    // work after service-worker recycling; UI consumers read
    // `topic_summary_index` instead.
    const hasCheckpointTopics =
      record.status === PIPELINE_STATUS.SUMMARIZING &&
      Array.isArray(record.topics) &&
      record.topics.length > 0;
    const resuming = hasCheckpointTopics && isSummaryCheckpointComplete(record);
    if (hasCheckpointTopics && !resuming) {
      await runtime.log('pipeline_resume_rejected', {
        stage: PIPELINE_STAGE.SUMMARIZING,
        topicCount: record.topics.length,
        sentenceCount: Array.isArray(record.sentences) ? record.sentences.length : 0,
      });
      throw new Error(
        'Cannot resume summaries because the saved sentence checkpoint is incomplete. Reprocess the record to rebuild it.',
      );
    }

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
      await runtime.update({
        status: PIPELINE_STATUS.SUMMARIZING,
        error: null,
        summariesIncomplete: false,
      });
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
    const previousSummaryIndex =
      resuming && record.topic_summary_index && typeof record.topic_summary_index === 'object'
        ? record.topic_summary_index
        : {};
    const forceFinalize = resuming && record.forceFinalize === true;
    const acceptedMergeFailurePaths =
      forceFinalize && Array.isArray(record.acceptedMergeFailurePaths)
        ? record.acceptedMergeFailurePaths
        : [];
    await runSummaries({
      runtime,
      topics,
      sentenceTexts,
      previousSummaries,
      previousSummaryIndex,
      forceFinalize,
      acceptedMergeFailurePaths,
      callLLMWithRetry,
    });
  } catch (error) {
    if (isCancellationError(error, runtime)) {
      // A superseded run id or external cancel lands here; leave the record's
      // status alone (a newer run owns it) but log so it's not invisible.
      pipelineLog.info('aborted:', key, (error && error.message) || error);
      return;
    }

    const formattedError = formatPipelineError(error);
    // A provider failure can settle just after the signal aborts; let the
    // run-id CAS decide ownership instead of treating it as cancellation.
    await runtime.log('pipeline_error', { error: formattedError }, { allowAborted: true });
    await runtime
      .update({ status: PIPELINE_STATUS.ERROR, error: formattedError }, { allowAborted: true })
      .catch((writeError) => {
        log.error('failed to persist error status to storage:', writeError);
      });
    throw error;
  } finally {
    await runtime.flushLogs();
  }
}
