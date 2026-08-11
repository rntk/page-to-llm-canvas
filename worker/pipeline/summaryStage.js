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
import { parseSummaryResult, runSourceText, shouldInlineRun } from './sourceSummarizer.js';
import { makeCachedSourceSummarizer } from './sourceSummaryCache.js';
import { PIPELINE_STAGE, PIPELINE_STATUS } from '../../src/shared/runtime/contracts.js';
import { isCancellationError, rethrowIfCancelled } from './cancellation.js';
import { isProviderFailure } from './providerFailure.js';
import { isFailedSummaryRun } from './summaryRunMarkers.js';

export { isCancellationError };

const ABORT_MESSAGE = 'pipeline aborted during summarization';

/** Maps provider/transport errors to stable UI categories and messages.
 * @param {unknown} error Provider or transport error.
 */
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
    summariesIncomplete: false,
    progress: { stage: PIPELINE_STAGE.NEEDS_ATTENTION, done, total },
  });
  await runtime.log('topic_summaries_needs_attention', {
    phase,
    errorCount: summaryErrors.length,
    topics: summaryErrors.map((error) => error.topic),
  });
}

/** Rebuilds a parked merge index using the current nodes' structural fields
 * while preserving prior run texts; returns null on any mismatch, so a
 * stale/corrupt checkpoint is recomputed normally.
 * @param {Map<string, {level: number, sourceSentences: number[]}>} nodes
 * @param {Record<string, object>} previousSummaryIndex
 * @param {string[]} acceptedMergeFailurePaths
 * @param {Record<string, object>} leafSummaries
 * @returns {Record<string, object>|null}
 */
function reuseParkedMergeIndex(
  nodes,
  previousSummaryIndex,
  acceptedMergeFailurePaths,
  leafSummaries,
) {
  if (
    !acceptedMergeFailurePaths.length ||
    !previousSummaryIndex ||
    typeof previousSummaryIndex !== 'object'
  ) {
    return null;
  }
  const currentPaths = [...nodes.keys()].filter(Boolean);
  const currentPathSet = new Set(currentPaths);
  if (!acceptedMergeFailurePaths.every((path) => currentPathSet.has(path))) return null;

  const reused = {};
  for (const path of currentPaths) {
    const node = nodes.get(path);
    const prior = previousSummaryIndex[path];
    if (!prior || !Array.isArray(prior.runs) || !Array.isArray(prior.source_sentences)) {
      return null;
    }
    const sameSource =
      prior.source_sentences.length === node.sourceSentences.length &&
      prior.source_sentences.every((id, index) => id === node.sourceSentences[index]);
    if (!sameSource) return null;

    // Every node carries exactly one run per contiguous source occurrence, in
    // document order; a mismatch (wrong-branch ids, non-string text) reads as
    // wrong text in place, not missing text, so it parks reuse.
    const expectedRuns = splitContiguousRuns(node.sourceSentences);
    if (prior.runs.length !== expectedRuns.length) return null;
    const sameRunLayout = expectedRuns.every((expected, index) => {
      const priorRun = prior.runs[index];
      return (
        priorRun &&
        typeof priorRun.text === 'string' &&
        Array.isArray(priorRun.sentences) &&
        priorRun.sentences.length === expected.length &&
        priorRun.sentences.every((id, sentenceIndex) => id === expected[sentenceIndex])
      );
    });
    if (!sameRunLayout) return null;

    if (node.children.length === 0) {
      const leafRuns = leafSummaries[path]?.runs;
      const sameRuns =
        Array.isArray(leafRuns) &&
        leafRuns.length === prior.runs.length &&
        leafRuns.every((run, runIndex) => {
          const priorRun = prior.runs[runIndex];
          return (
            priorRun &&
            run.text === priorRun.text &&
            Array.isArray(run.sentences) &&
            Array.isArray(priorRun.sentences) &&
            run.sentences.length === priorRun.sentences.length &&
            run.sentences.every((id, sentenceIndex) => id === priorRun.sentences[sentenceIndex])
          );
        });
      if (!sameRuns) return null;
    }
    reused[path] = {
      runs: prior.runs,
      level: node.level - 1,
      source_sentences: node.sourceSentences,
    };
  }
  return reused;
}

/** Wraps the tree summarizer for a Skip resume: an accepted merge node stays
 * empty, and an accepted leaf's sentence ids are excluded from ancestor
 * requests while unaffected source in the same run still summarizes.
 * @param {Function} summarizeSource
 * @param {Record<string, object>} leafSummaries
 * @param {string[]} acceptedMergeFailurePaths
 * @returns {Function}
 */
function makeForceFinalizeSummarizer(summarizeSource, leafSummaries, acceptedMergeFailurePaths) {
  const acceptedLeaves = Object.entries(leafSummaries)
    .filter(
      ([path, summary]) =>
        path && summary?.acceptedFailure === true && Array.isArray(summary.source_sentences),
    )
    .map(([path, summary]) => {
      const acceptedRuns = Array.isArray(summary.runs)
        ? summary.runs.filter((run) => run?.acceptedFailure === true)
        : [];
      const sentenceIds = acceptedRuns.length
        ? acceptedRuns.flatMap((run) => (Array.isArray(run.sentences) ? run.sentences : []))
        : summary.acceptedFailure === true
          ? summary.source_sentences
          : [];
      return { path, sentenceIds: new Set(sentenceIds) };
    })
    .filter(({ sentenceIds }) => sentenceIds.size > 0);
  const acceptedMergePaths = new Set(
    acceptedMergeFailurePaths.filter((path) => typeof path === 'string' && path),
  );

  return async (sourceSentenceIds, info = {}) => {
    const path = typeof info.path === 'string' ? info.path : '';
    if (path && acceptedMergePaths.has(path)) return { runs: [] };

    const excludedSentenceIds = new Set();
    for (const acceptedLeaf of acceptedLeaves) {
      if (acceptedLeaf.path === path || acceptedLeaf.path.startsWith(`${path}>`)) {
        for (const sentenceId of acceptedLeaf.sentenceIds) excludedSentenceIds.add(sentenceId);
      }
    }
    if (excludedSentenceIds.size === 0) {
      return await summarizeSource(sourceSentenceIds, info);
    }

    const originalRuns = splitContiguousRuns(sourceSentenceIds);
    const safeSentenceIds = sourceSentenceIds.filter(
      (sentenceId) => !excludedSentenceIds.has(sentenceId),
    );
    if (safeSentenceIds.length === 0) return { runs: [] };

    const safeSummary = await summarizeSource(safeSentenceIds, info);
    const safeRuns = Array.isArray(safeSummary?.runs) ? safeSummary.runs : [];
    return {
      // summarizeTopicTree reassembles by the run's original first sentence;
      // keep that range while joining only the non-accepted fragments' text.
      runs: originalRuns.map((run) => {
        const runIds = new Set(run);
        return {
          sentences: run,
          text: safeRuns
            .filter((safeRun) => safeRun.sentences?.some((sentenceId) => runIds.has(sentenceId)))
            .map((safeRun) => safeRun.text)
            .filter(Boolean)
            .join('\n'),
        };
      }),
    };
  };
}

/** Finalizes a run without summary calls while preserving its computed topics.
 * @param {PipelineRuntime} runtime Pipeline runtime.
 * @param {object[]} topics Computed topic records.
 */
export async function finalizeSummariesDisabled(runtime, topics) {
  await runtime.log('summaries_disabled_skip', { topicCount: topics.length });
  await runtime.update({
    status: PIPELINE_STATUS.DONE,
    topic_summaries: {},
    topic_summary_index: {},
    source_summary_units: {},
    summariesDisabled: true,
    summariesIncomplete: false,
    progress: { stage: PIPELINE_STAGE.DONE, done: topics.length, total: topics.length },
    summaryErrors: [],
    forceFinalize: false,
    acceptedMergeFailurePaths: [],
  });
  await runtime.log('pipeline_done', {
    topicCount: topics.length,
    summaryNodeCount: 0,
  });
}

/**
 * Generates missing leaf summaries, resolves the topic-summary tree, and
 * either finalizes the record or parks it for a retry/skip decision.
 * @param {object} input Summary-stage dependencies and state.
 */
export async function runSummaries({
  runtime,
  topics,
  sentenceTexts,
  previousSummaries,
  previousSummaryIndex = {},
  previousSourceSummaryUnits = {},
  contentRevision,
  forceFinalize = false,
  acceptedMergeFailurePaths = [],
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

      const { runResults, pendingRunIndexes, acceptedFailure, previousFailure } = topic;
      // A pending run is represented by its structurally valid empty slot plus
      // the topic-level error marker. This keeps the UI/index run shape
      // backward-compatible while making each successful slot durable.
      const unresolved = new Set(pendingRunIndexes);
      let failure = null;
      const pendingFailure = previousFailure;

      const persistLeafCheckpoint = async () => {
        const hasUnresolved = unresolved.size > 0;
        topic_summaries[topic.name] = {
          runs: runResults,
          source_sentences: topic.sentences,
          ...(hasUnresolved
            ? {
                error: true,
                ...(failure ||
                  pendingFailure || {
                    error_kind: 'error',
                    error_message: 'Summary is incomplete.',
                  }),
              }
            : {}),
          ...(acceptedFailure ? { acceptedFailure: true } : {}),
        };
        await runtime.update({
          topic_summaries: { ...topic_summaries },
          progress: { stage: PIPELINE_STAGE.SUMMARIZING_TOPICS, done, total },
        });
      };

      for (const [runIndex, runResult] of runResults.entries()) {
        if (!unresolved.has(runIndex)) continue;
        const runIds = runResult.sentences;
        const sourceText = runSourceText(runIds, sentenceTexts);
        if (!sourceText) {
          unresolved.delete(runIndex);
          runResults[runIndex] = {
            sentences: runIds,
            text: '',
          };
          await persistLeafCheckpoint();
          continue;
        }
        if (shouldInlineRun(runIds, sourceText)) {
          unresolved.delete(runIndex);
          runResults[runIndex] = {
            sentences: runIds,
            text: sourceText,
          };
          await persistLeafCheckpoint();
          continue;
        }

        // Only the provider call is guarded: a throw from prompt building or
        // parsing is a code bug that must surface as a pipeline error, not a Retry button.
        const prompt = buildArticleSummaryPrompt(sourceText, {
          preferContentLanguage: runtime.preferContentLanguage,
        });
        let response;
        try {
          response = await callLLMWithRetry({
            prompt,
            temperature: 0.8,
            signal: runtime.signal,
            taskType: LLM_TASK_TYPES.ARTICLE_SUMMARY,
          });
        } catch (error) {
          rethrowIfCancelled(error, runtime, ABORT_MESSAGE);
          const { kind, message } = classifyLlmError(error);
          const detail = (error && error.message) || String(error);
          await runtime.log('topic_summary_llm_error', {
            topic: topic.name,
            error_kind: kind,
            error: message,
            detail,
          });
          const runFailure = {
            error_kind: kind,
            error_message: message,
            error_detail: detail,
          };
          failure = failure || runFailure;
          runResults[runIndex] = {
            sentences: runIds,
            text: '',
            error: true,
            ...runFailure,
          };
          await persistLeafCheckpoint();
          continue;
        }

        const parsed = parseSummaryResult(response);
        unresolved.delete(runIndex);
        runResults[runIndex] = {
          sentences: runIds,
          text: parsed.text || (parsed.noSummary ? sourceText : ''),
        };
        await persistLeafCheckpoint();
      }

      topic_summaries[topic.name] = {
        runs: runResults,
        source_sentences: topic.sentences,
        ...(unresolved.size > 0
          ? {
              error: true,
              ...(failure ||
                pendingFailure || {
                  error_kind: 'error',
                  error_message: 'Summary is incomplete.',
                }),
            }
          : {}),
        ...(acceptedFailure ? { acceptedFailure: true } : {}),
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
  // `forceFinalize` only honors acceptedFailure markers already in the
  // checkpoint, not failures since the user clicked Skip: accepted leaves no
  // longer have `error: true`, so every error collected here is new.
  if (leafErrors.length) {
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
  const summaryErrors = [];
  const source_summary_units =
    previousSourceSummaryUnits && typeof previousSourceSummaryUnits === 'object'
      ? { ...previousSourceSummaryUnits }
      : {};
  let topic_summary_index = forceFinalize
    ? reuseParkedMergeIndex(nodes, previousSummaryIndex, acceptedMergeFailurePaths, topic_summaries)
    : null;
  if (topic_summary_index) {
    await runtime.log(
      'topic_tree_merge_reused',
      { nodeCount: Object.keys(topic_summary_index).length },
      { verbose: true },
    );
  } else {
    const normalSummarizeSource = makeCachedSourceSummarizer({
      sentenceTexts,
      limit: createLimiter(SUMMARY_CONCURRENCY),
      signal: runtime.signal,
      preferContentLanguage: runtime.preferContentLanguage,
      callLLMWithRetry,
      priorUnits: source_summary_units,
      contentRevision,
      persistUnit: async (unit) => {
        source_summary_units[unit.unitId] = unit;
        await runtime.update({
          source_summary_units: { ...source_summary_units },
        });
      },
    });
    // A complete parked merge index can be reused above; otherwise force-finalize
    // suppresses only user-accepted paths so Retry doesn't empty other branches.
    const summarizeSource = forceFinalize
      ? makeForceFinalizeSummarizer(
          normalSummarizeSource,
          topic_summaries,
          acceptedMergeFailurePaths,
        )
      : normalSummarizeSource;
    topic_summary_index = await summarizeTopicTree({
      nodes,
      leafSummaries: topic_summaries,
      summarizeSource,
      // A normal Retry can adopt each structurally valid prior merge path. Skip
      // remains on the existing force-finalize path because accepted failures
      // must suppress only their own branches.
      previousSummaryIndex,
      reusePriorSummaries: !forceFinalize,
      onError: ({ path, error }) => {
        rethrowIfCancelled(error, runtime);
        // Same policy as above: `makeSourceSummarizer` marks provider rejections,
        // so anything unmarked is our own bug and must surface, not park behind Retry.
        if (!isProviderFailure(error)) throw error;
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
  }
  await runtime.log(
    'topic_tree_merge_done',
    { nodeCount: Object.keys(topic_summary_index).length },
    { verbose: true },
  );

  // Accepted merge paths are suppressed/reused above, so any error collected
  // here is new, even on a force-finalizing resume.
  if (summaryErrors.length) {
    // Persist the failed path on the projection itself. Older parked records
    // only had summaryErrors, but new normal Retries need a durable per-path
    // distinction after the background handler clears that transient list.
    for (const { topic: path } of summaryErrors) {
      if (topic_summary_index[path]) {
        topic_summary_index[path] = { ...topic_summary_index[path], error: true };
      }
    }
    await parkForReview(runtime, summaryErrors, 'merge', topic_summary_index, {
      done: total,
      total,
    });
    return;
  }

  // Finalization replaces in-flight `error`/`acceptedFailure` markers with
  // `forcedEmpty`, which is the durable DONE-state signal for a later retry.
  const finalizedSummaries = {};
  for (const [name, summary] of Object.entries(topic_summaries)) {
    const finalRuns = (Array.isArray(summary.runs) ? summary.runs : []).map((run) => {
      const accepted = run?.acceptedFailure === true || isFailedSummaryRun(run);
      return {
        sentences: run.sentences,
        text: typeof run.text === 'string' ? run.text : '',
        ...(accepted ? { forcedEmpty: true } : {}),
      };
    });
    const hasForcedEmptyRun = finalRuns.some((run) => run.forcedEmpty === true);
    finalizedSummaries[name] = {
      runs: finalRuns,
      source_sentences: summary.source_sentences,
      ...(summary.error || summary.acceptedFailure || hasForcedEmptyRun
        ? { forcedEmpty: true }
        : {}),
    };
  }

  await runtime.update({
    status: PIPELINE_STATUS.DONE,
    topic_summaries: finalizedSummaries,
    topic_summary_index,
    source_summary_units: {},
    // Summaries ran, so `summariesDisabled` stays false and the ones that
    // succeeded remain viewable. A skipped leaf stays retryable
    // (`forcedEmpty`) rather than looking like every summary is absent.
    summariesDisabled: false,
    summariesIncomplete:
      acceptedMergeFailurePaths.length > 0 ||
      Object.values(finalizedSummaries).some((summary) => summary.forcedEmpty === true),
    progress: { stage: PIPELINE_STAGE.DONE, done: total, total },
    summaryErrors: [],
    forceFinalize: false,
    acceptedMergeFailurePaths: [],
  });
  await runtime.log('pipeline_done', {
    topicCount: total,
    summaryNodeCount: Object.keys(topic_summary_index).length,
  });
}
