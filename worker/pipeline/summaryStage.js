import { buildArticleSummaryPrompt } from './prompts.js';
import { createLimiter, parallelMap } from '../llm/llm.js';
import { LLM_TASK_TYPES } from '../metrics/llm.js';
import { planSummaryWork } from './summaryPlanning.js';
import {
  buildPartialTopicSummaryIndex,
  buildTopicTree,
  summarizeTopicTree,
  splitContiguousRuns,
} from './topicTreeMerge.js';
import { SUMMARY_CONCURRENCY } from './pipelineConfig.js';
import {
  makeSourceSummarizer,
  parseSummaryResult,
  runSourceText,
  shouldInlineRun,
} from './sourceSummarizer.js';
import { PIPELINE_STAGE, PIPELINE_STATUS } from '../../src/shared/runtime/contracts.js';

/** Maps provider/transport errors to stable UI categories and messages. */
export function classifyLlmError(error) {
  const raw = (error && error.message) || String(error);
  if (/timed out|timeout/i.test(raw)) {
    return { kind: 'timeout', message: 'The model did not respond in time.' };
  }
  if (/\b429\b|rate.?limit/i.test(raw)) {
    return { kind: 'rate_limited', message: 'The model provider is rate limiting requests.' };
  }
  if (/no llm provider|provider configured|no model configured/i.test(raw)) {
    return { kind: 'no_provider', message: 'No model is configured. Add one in the options page.' };
  }
  if (/\b401\b|\b403\b|unauthor|forbidden|api key/i.test(raw)) {
    return {
      kind: 'auth',
      message: 'The model provider rejected the request (check your API key).',
    };
  }
  const message = raw.length > 200 ? `${raw.slice(0, 200)}…` : raw;
  return { kind: 'error', message };
}

function collectSummaryErrors(topicSummaries) {
  const errors = [];
  for (const [topic, summary] of Object.entries(topicSummaries)) {
    if (summary && summary.error) {
      errors.push({
        topic,
        error_kind: summary.error_kind || 'error',
        error_message: summary.error_message || 'Summary failed.',
        error_detail: summary.error_detail,
      });
    }
  }
  return errors;
}

async function parkForReview(runtime, summaryErrors, phase, topicSummaryIndex, { done, total }) {
  await runtime.update({
    status: PIPELINE_STATUS.NEEDS_ATTENTION,
    topic_summary_index: topicSummaryIndex,
    summaryErrors,
    forceFinalize: false,
    progress: { stage: PIPELINE_STAGE.NEEDS_ATTENTION, done, total },
  });
  await runtime.log('topic_summaries_needs_attention', {
    phase,
    errorCount: summaryErrors.length,
    topics: summaryErrors.map((error) => error.topic),
  });
}

/** Finalizes a run without summary calls while preserving its computed topics. */
export async function finalizeSummariesDisabled(runtime, topics) {
  await runtime.log('summaries_disabled_skip', { topicCount: topics.length });
  await runtime.update({
    status: PIPELINE_STATUS.DONE,
    topic_summaries: {},
    topic_summary_index: {},
    summariesDisabled: true,
    progress: { stage: PIPELINE_STAGE.DONE, done: topics.length, total: topics.length },
    summaryErrors: [],
    forceFinalize: false,
  });
  await runtime.log('pipeline_done', {
    topicCount: topics.length,
    summaryNodeCount: 0,
  });
}

/**
 * Generates missing leaf summaries, resolves the topic-summary tree, and
 * either finalizes the record or parks it for a retry/skip decision.
 */
export async function runSummaries({
  runtime,
  topics,
  sentenceTexts,
  previousSummaries,
  forceFinalize = false,
  callLLMWithRetry,
}) {
  const { reused, pending, reusedCount, pendingCount, total } = planSummaryWork(
    topics,
    previousSummaries,
  );
  const topic_summaries = { ...reused };

  let done = reusedCount;
  await runtime.update({
    progress: { stage: PIPELINE_STAGE.SUMMARIZING_TOPICS, done, total },
  });
  if (pendingCount < total) {
    await runtime.log(
      'topic_summaries_reused',
      { reusedCount, pendingCount, total },
      { verbose: true },
    );
  }

  if (pending.length > 1) {
    await runtime.log(
      'topic_summaries_warmup',
      { pendingCount: pending.length, concurrency: SUMMARY_CONCURRENCY },
      { verbose: true },
    );
  }

  await parallelMap(
    pending,
    SUMMARY_CONCURRENCY,
    async (topic) => {
      await runtime.log(
        'topic_summary_llm_request',
        { topic: topic.name, sentenceCount: topic.sentences.length },
        { verbose: true },
      );

      const runs = splitContiguousRuns(topic.sentences);
      const runResults = [];
      let failure = null;
      for (const runIds of runs) {
        const sourceText = runSourceText(runIds, sentenceTexts);
        if (!sourceText) {
          runResults.push({ sentences: runIds, text: '' });
          continue;
        }
        if (shouldInlineRun(runIds, sourceText)) {
          runResults.push({ sentences: runIds, text: sourceText });
          continue;
        }

        try {
          const response = await callLLMWithRetry({
            prompt: buildArticleSummaryPrompt(sourceText, {
              preferContentLanguage: runtime.preferContentLanguage,
            }),
            temperature: 0.8,
            signal: runtime.signal,
            taskType: LLM_TASK_TYPES.ARTICLE_SUMMARY,
          });
          const parsed = parseSummaryResult(response);
          runResults.push({
            sentences: runIds,
            text: parsed.text || (parsed.noSummary ? sourceText : ''),
          });
        } catch (error) {
          const { kind, message } = classifyLlmError(error);
          const detail = (error && error.message) || String(error);
          await runtime.log('topic_summary_llm_error', {
            topic: topic.name,
            error_kind: kind,
            error: message,
            detail,
          });
          failure = failure || {
            error_kind: kind,
            error_message: message,
            error_detail: detail,
          };
          runResults.push({ sentences: runIds, text: '' });
        }
      }

      topic_summaries[topic.name] = {
        runs: runResults,
        source_sentences: topic.sentences,
        ...(failure ? { error: true, ...failure } : {}),
      };
      done++;
      await runtime.log(
        'topic_summary_llm_response',
        { topic: topic.name, runCount: runResults.length },
        { verbose: true },
      );
      await runtime.update({
        topic_summaries: { ...topic_summaries },
        progress: { stage: PIPELINE_STAGE.SUMMARIZING_TOPICS, done, total },
      });
    },
    { warmupFirst: true },
  );

  const leafErrors = collectSummaryErrors(topic_summaries);
  if (leafErrors.length && !forceFinalize) {
    await parkForReview(
      runtime,
      leafErrors,
      'leaf',
      buildPartialTopicSummaryIndex(topics, topic_summaries),
      { done, total },
    );
    return;
  }

  await runtime.log('topic_tree_merge_start', { leafCount: total }, { verbose: true });
  const { nodes } = buildTopicTree(topics);
  const limitSummary = createLimiter(SUMMARY_CONCURRENCY);
  const summaryErrors = [];
  const summarizeSource = forceFinalize
    ? async () => ({ runs: [] })
    : makeSourceSummarizer({
        sentenceTexts,
        limit: limitSummary,
        signal: runtime.signal,
        preferContentLanguage: runtime.preferContentLanguage,
        callLLMWithRetry,
      });
  const topic_summary_index = await summarizeTopicTree({
    nodes,
    leafSummaries: topic_summaries,
    summarizeSource,
    onError: ({ path, error }) => {
      const { kind, message } = classifyLlmError(error);
      summaryErrors.push({
        topic: path,
        error_kind: kind,
        error_message: message,
        error_detail: String(error),
      });
      return runtime.log('topic_tree_merge_error', {
        path,
        error_kind: kind,
        error: message,
      });
    },
  });
  await runtime.log(
    'topic_tree_merge_done',
    { nodeCount: Object.keys(topic_summary_index).length },
    { verbose: true },
  );

  if (summaryErrors.length && !forceFinalize) {
    await parkForReview(runtime, summaryErrors, 'merge', topic_summary_index, {
      done: total,
      total,
    });
    return;
  }

  const finalizedSummaries = {};
  for (const [name, summary] of Object.entries(topic_summaries)) {
    finalizedSummaries[name] = {
      runs: Array.isArray(summary.runs) ? summary.runs : [],
      source_sentences: summary.source_sentences,
    };
  }

  await runtime.update({
    status: PIPELINE_STATUS.DONE,
    topic_summaries: finalizedSummaries,
    topic_summary_index,
    summariesDisabled: false,
    progress: { stage: PIPELINE_STAGE.DONE, done: total, total },
    summaryErrors: [],
    forceFinalize: false,
  });
  await runtime.log('pipeline_done', {
    topicCount: total,
    summaryNodeCount: Object.keys(topic_summary_index).length,
  });
}
