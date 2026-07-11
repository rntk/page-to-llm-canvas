// Pipeline entry point: clean HTML, split sentences, find topic ranges, and
// generate per-topic summaries. This runs in the service-worker context.

import { callLLMWithRetry as callLLMWithRetryRaw } from './llm.js';
import { wrapCallLLMWithRetry } from './llmMetrics.js';
import { getStoredPreferContentLanguage } from './languageSettings.js';
import { getStoredVerboseLogs } from './verboseLogSettings.js';
import { createPipelineRuntime, formatPipelineError } from './pipelineRuntime.js';
import { computeTopics } from './topicRangesStage.js';
import { finalizeSummariesDisabled, runSummaries } from './summaryStage.js';

// Isolated request metrics: all stages receive the same wrapped LLM boundary.
const callLLMWithRetry = wrapCallLLMWithRetry(callLLMWithRetryRaw);

/**
 * Runs or resumes the persisted article-processing pipeline.
 *
 * @param {string} key
 * @param {{pipelineRunId?: string, signal?: AbortSignal}} [options]
 */
export async function runPipeline(key, options = {}) {
  const runtime = createPipelineRuntime({
    key,
    pipelineRunId: options.pipelineRunId,
    signal: options.signal,
    // Snapshot settings once so mid-run changes do not alter prompt or logging
    // behavior, including across service-worker resume calls.
    preferContentLanguage: await getStoredPreferContentLanguage(),
    verboseLogs: await getStoredVerboseLogs(),
    summariesDisabled: false,
  });

  try {
    await runtime.log('pipeline_start');
    const record = await runtime.read();
    if (!record) throw new Error(`record not found: ${key}`);
    runtime.summariesDisabled = record.skipSummaries === true;

    // A summarizing record has already persisted topics for its current HTML.
    // Reuse them after service-worker recycling and fill only missing summaries.
    const resuming =
      record.status === 'summarizing' && Array.isArray(record.topics) && record.topics.length > 0;

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
        stage: 'summarizing',
        topicCount: topics.length,
        existingSummaryCount: Object.keys(existingSummaries).length,
      });
      await runtime.update({ status: 'summarizing', error: null });
    } else {
      ({ topics, sentenceTexts } = await computeTopics(runtime, record, callLLMWithRetry));
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
    await runtime.update({ status: 'error', error: formattedError }).catch((writeError) => {
      console.error('PageToLLM Canvas: failed to persist error status to storage:', writeError);
    });
    throw error;
  } finally {
    await runtime.flushLogs();
  }
}
