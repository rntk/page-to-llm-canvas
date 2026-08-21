import { createLimiter } from '../llm/llm.js';
import { planSummaryWork } from './summaryPlanning.js';
import {
  buildPartialTopicSummaryIndex,
  buildTopicTree,
  summarizeTopicTree,
  splitContiguousRuns,
} from './topicTreeMerge.js';
import { SUMMARY_CONCURRENCY } from './pipelineConfig.js';
import { makeCachedSourceSummarizer } from './sourceSummaryCache.js';
import { PIPELINE_STAGE, PIPELINE_STATUS } from '../../src/shared/runtime/contracts.js';
import { isCanonicalDescendantPath } from '../../src/shared/runtime/topicPath.js';
import { isCancellationError, rethrowIfCancelled } from './cancellation.js';
import { isPermanentProviderError, isProviderFailure } from './providerFailure.js';
import { runProviderBurst } from './providerBurst.js';
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
      if (acceptedLeaf.path === path || isCanonicalDescendantPath(acceptedLeaf.path, path)) {
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
 * @param {object} [options]
 * @param {boolean} [options.preserveExistingSummaries]
 */
export async function finalizeSummariesDisabled(
  runtime,
  topics,
  { preserveExistingSummaries = false } = {},
) {
  await runtime.log('summaries_disabled_skip', { topicCount: topics.length });
  await runtime.update({
    status: PIPELINE_STATUS.DONE,
    ...(!preserveExistingSummaries
      ? { topic_summaries: {}, topic_summary_index: {}, source_summary_units: {} }
      : {}),
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
  const source_summary_units =
    previousSourceSummaryUnits && typeof previousSourceSummaryUnits === 'object'
      ? { ...previousSourceSummaryUnits }
      : {};
  const persistSourceSummaryUnit = async (unit) => {
    source_summary_units[unit.unitId] = unit;
    await runtime.update({ source_summary_units: { ...source_summary_units } });
  };
  const leafSummarizeSource = makeCachedSourceSummarizer({
    sentenceTexts,
    limit: createLimiter(SUMMARY_CONCURRENCY),
    signal: runtime.signal,
    preferContentLanguage: runtime.preferContentLanguage,
    callLLMWithRetry,
    priorUnits: source_summary_units,
    contentRevision,
    persistUnit: persistSourceSummaryUnit,
    summaryMode: 'leaf',
    maxChars: runtime.maxTextChunkChars,
  });

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

  // A permanent provider failure (401, unknown model) condemns every remaining
  // topic as well, so the burst stops claiming them instead of spending one
  // doomed request per topic. The unclaimed topics are recorded below with the
  // same failure so they park for review rather than vanishing from
  // `topic_summaries` and letting the merge phase run on missing leaves.
  const { permanentError, unclaimed: skipped } = await runProviderBurst(
    pending,
    SUMMARY_CONCURRENCY,
    async ({ item: topic }) => {
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
      let providerError = null;
      const pendingFailure = previousFailure;

      const buildLeafSummaryEntry = () => {
        const hasUnresolved = unresolved.size > 0;
        return {
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
      };

      const persistLeafCheckpoint = async () => {
        topic_summaries[topic.name] = buildLeafSummaryEntry();
        await runtime.update({
          topic_summaries: { ...topic_summaries },
          progress: { stage: PIPELINE_STAGE.SUMMARIZING_TOPICS, done, total },
        });
      };

      for (const [runIndex, runResult] of runResults.entries()) {
        if (!unresolved.has(runIndex)) continue;
        const runIds = runResult.sentences;
        try {
          const summarized = await leafSummarizeSource(runIds, { path: topic.name });
          const summarizedRuns = summarized?.runs;
          // Each pending plan item is one contiguous run, so the source
          // summarizer must return exactly one result. Fail loudly if that
          // contract changes instead of silently discarding later runs.
          if (!Array.isArray(summarizedRuns) || summarizedRuns.length !== 1) {
            throw new Error(
              `Expected exactly one summary run for topic "${topic.name}", received ${
                Array.isArray(summarizedRuns) ? summarizedRuns.length : 'invalid output'
              }`,
            );
          }
          const [summarizedRun] = summarizedRuns;
          const matchesPlannedRun =
            summarizedRun &&
            Array.isArray(summarizedRun.sentences) &&
            summarizedRun.sentences.length === runIds.length &&
            summarizedRun.sentences.every((sentenceId, index) => sentenceId === runIds[index]) &&
            typeof summarizedRun.text === 'string';
          if (!matchesPlannedRun) {
            throw new Error(`Summary run did not match the planned run for topic "${topic.name}"`);
          }
          unresolved.delete(runIndex);
          runResults[runIndex] = {
            sentences: runIds,
            text: summarizedRun.text,
          };
        } catch (error) {
          rethrowIfCancelled(error, runtime, ABORT_MESSAGE);
          // Provider failures are actionable through Retry/Skip. A prompt,
          // chunking, cache, or parsing bug is not and must fail the pipeline.
          if (!isProviderFailure(error)) throw error;
          const isPermanentFailure = isPermanentProviderError(error);
          if (!providerError || isPermanentFailure) providerError = error;
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
          // This topic's remaining runs are condemned by the same permanent
          // failure. They stay in `unresolved`, so the topic still parks with
          // its error marker — it just does not buy one rejection per run to
          // get there.
          if (isPermanentFailure) break;
          continue;
        }
        await persistLeafCheckpoint();
      }

      topic_summaries[topic.name] = buildLeafSummaryEntry();
      if (unresolved.size === 0) done++;
      await runtime.log(
        'topic_summary_llm_response',
        { topic: topic.name, runCount: runResults.length },
        { verbose: true },
      );
      await runtime.update({
        topic_summaries: { ...topic_summaries },
        progress: { stage: PIPELINE_STAGE.SUMMARIZING_TOPICS, done, total },
      });
      return { error: providerError };
    },
  );

  if (permanentError) {
    if (skipped.length > 0) {
      const { kind, message } = classifyLlmError(permanentError);
      const detail = (permanentError && permanentError.message) || String(permanentError);
      for (const topic of skipped) {
        topic_summaries[topic.name] = {
          runs: topic.runResults,
          source_sentences: topic.sentences,
          error: true,
          error_kind: kind,
          error_message: message,
          error_detail: detail,
          ...(topic.acceptedFailure ? { acceptedFailure: true } : {}),
        };
      }
      await runtime.log('topic_summaries_skipped', {
        skippedTopicCount: skipped.length,
        error_kind: kind,
        error: message,
        detail,
      });
      await runtime.update({ topic_summaries: { ...topic_summaries } });
    }
  }

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

  // Internal nodes do not map cleanly to a determinate request count: some
  // delegate to a child, some reuse prior work, and others fan out through
  // source-summary chunking. Switch to an explicit indeterminate phase instead
  // of leaving the leaf counter displayed at 100% while merge work is running.
  await runtime.update({
    progress: { stage: PIPELINE_STAGE.MERGING_SUMMARIES, done: 0, total: 0 },
  });
  await runtime.log('topic_tree_merge_start', { leafCount: total }, { verbose: true });
  const { nodes } = buildTopicTree(topics);
  const summaryErrors = [];
  const normalSummarizeSource = makeCachedSourceSummarizer({
    sentenceTexts,
    limit: createLimiter(SUMMARY_CONCURRENCY),
    signal: runtime.signal,
    preferContentLanguage: runtime.preferContentLanguage,
    callLLMWithRetry,
    priorUnits: source_summary_units,
    contentRevision,
    persistUnit: persistSourceSummaryUnit,
    maxChars: runtime.maxTextChunkChars,
  });
  const summarizeSource = forceFinalize
    ? makeForceFinalizeSummarizer(normalSummarizeSource, topic_summaries, acceptedMergeFailurePaths)
    : normalSummarizeSource;
  const topic_summary_index = await summarizeTopicTree({
    nodes,
    leafSummaries: topic_summaries,
    summarizeSource,
    // Reuse is per run and failure-aware for both Retry and Skip. Accepted
    // paths are suppressed by summarizeSource while unrelated successful
    // paths retain their already-paid-for summaries.
    previousSummaryIndex,
    reusePriorSummaries: true,
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
  await runtime.log(
    'topic_tree_merge_done',
    { nodeCount: Object.keys(topic_summary_index).length },
    { verbose: true },
  );

  // Accepted merge paths are suppressed during generation, so any error collected
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
      done: 0,
      total: 0,
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
