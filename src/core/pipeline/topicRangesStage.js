import { normalizeCapturedText } from './capturedText.js';
import { splitSentences } from './sentenceSplitter.js';
import { groupsToTopics } from './topicRangeMapping.js';
import { createTopicRangeDependencies } from './topicRangeDependencies.js';
import { splitTopicRanges } from './topicRangeSplit.js';
import {
  boundariesToRanges,
  decideTopicBoundaries,
  SEGMENTATION_BRIEF,
  DECISION_SPLIT_THRESHOLD,
  DECISION_BATCH_SIZE,
  DECISION_CONTEXT_SENTENCES,
  DECISION_MAX_SENTENCE_CHARS,
} from './decisionTopicBoundaries.js';
import { labelTopicRanges } from './topicRangeLabels.js';
import { buildTopicLabelsPrompt } from './prompts.js';
import { createDecisionCheckpoint } from './decisionCheckpoint.js';
import { executeDecisionStage } from './decisionStageExecution.js';
import { PIPELINE_STAGE } from '../../shared/runtime/contracts.js';
import {
  doneTransition,
  progressAt,
  resetSummaryCheckpointPatch,
  splittingTransition,
  summarizingTransition,
} from '../../shared/runtime/recordTransitions.js';

/**
 * Decision-API split: the decision model places range boundaries, then the
 * completion LLM names each range. Completed gaps and labels are checkpointed.
 * @param {object} input Stage capabilities and source snapshot.
 */
async function splitWithDecisions(input) {
  return executeDecisionStage(
    input.runtime,
    input.dependencies.parallelMap,
    (runtime, parallelMap) =>
      splitDecisionRanges({
        ...input,
        runtime,
        checkpointRuntime: input.runtime,
        dependencies: { ...input.dependencies, parallelMap },
      }),
  );
}

async function splitDecisionRanges({
  runtime,
  checkpointRuntime,
  record,
  text,
  sentenceObjs,
  sentenceTexts,
  decide,
  callLLMWithRetry,
  dependencies,
  decisionOptions = {},
}) {
  const checkpoint = await createDecisionCheckpoint({
    // Sibling failure stops requests, but completed work must still be saved.
    // The parent runtime retains user cancellation and run-ownership guards.
    runtime: checkpointRuntime,
    record,
    text: JSON.stringify([text, sentenceObjs]),
    policy: [
      decisionOptions,
      SEGMENTATION_BRIEF,
      DECISION_SPLIT_THRESHOLD,
      DECISION_BATCH_SIZE,
      DECISION_CONTEXT_SENTENCES,
      DECISION_MAX_SENTENCE_CHARS,
      runtime.maxTextChunkChars,
      buildTopicLabelsPrompt('', {
        preferContentLanguage: runtime.preferContentLanguage,
      }),
    ],
  });
  await runtime.update({
    sentences: sentenceTexts,
    progress: progressAt(PIPELINE_STAGE.TOPIC_RANGES, 0, sentenceTexts.length),
  });
  const boundaries = await decideTopicBoundaries({
    decide,
    sentences: sentenceObjs,
    text,
    runtime,
    parallelMap: dependencies.parallelMap,
    contextWindowTokens: decisionOptions.contextWindowTokens,
    checkpoint,
  });
  const ranges = boundariesToRanges(sentenceTexts.length, boundaries);
  const sizes = ranges.map((range) => range.end - range.start + 1).sort((a, b) => a - b);
  await runtime.log('topic_boundaries_done', {
    rangeCount: ranges.length,
    boundaryCount: boundaries.length,
    minSentences: sizes[0] ?? 0,
    maxSentences: sizes.at(-1) ?? 0,
    medianSentences: sizes.length ? sizes[Math.floor((sizes.length - 1) / 2)] : 0,
    singleSentenceRangeCount: sizes.filter((size) => size === 1).length,
  });
  return labelTopicRanges({
    runtime,
    ranges,
    sentenceTexts,
    callLLMWithRetry,
    parallelMap: dependencies.parallelMap,
    checkpoint,
  });
}

/**
 * Cleans the HTML, splits sentences, and runs the topic-ranges stage.
 * Returns topics:null when no sentences were found and the record was finalized.
 *
 * @param {object} input
 * @param {PipelineRuntime} input.runtime
 * @param {object} input.record
 * @param {Function} input.callLLMWithRetry
 * @param {Function} [input.decide] Decision API request; when present, ranges come
 *   from decision boundaries and the LLM only names them.
 * @param {object} [input.dependencies] Telemetry, execution, and checkpoint capabilities.
 * @param {object} [input.decisionOptions] Decision budget and provider cache identity.
 */
export async function computeTopics({
  runtime,
  record,
  callLLMWithRetry,
  decide,
  dependencies: overrides,
  decisionOptions,
}) {
  const dependencies = createTopicRangeDependencies(overrides);
  await runtime.update({
    ...splittingTransition(),
    // Clear path-scoped review decisions when recomputing the tree; a later
    // retry must not reactivate decisions for old paths.
    ...resetSummaryCheckpointPatch(),
    summariesDisabled: false,
  });
  const capturedText = String(record?.capturedText ?? '');
  await runtime.log(
    'normalizing_text_start',
    {
      capturedTextLength: capturedText.length,
      source: 'captured_text',
    },
    { verbose: true },
  );

  // Captured text is already filtered in the page; parsing it as HTML would
  // corrupt literal markup characters and undo visibility filtering.
  const text = normalizeCapturedText(capturedText);
  await runtime.log(
    'normalizing_text_done',
    {
      textLength: text.length,
      source: 'captured_text',
    },
    { verbose: true },
  );

  await runtime.update({
    text,
    progress: progressAt(PIPELINE_STAGE.SPLITTING_SENTENCES),
  });
  await runtime.log('splitting_sentences_start', {}, { verbose: true });

  const sentenceObjs = splitSentences(text);
  const sentenceTexts = sentenceObjs.map((sentence) => sentence.text);
  await runtime.log(
    'splitting_sentences_done',
    { sentenceCount: sentenceTexts.length },
    { verbose: true },
  );

  if (sentenceTexts.length === 0) {
    await runtime.update({
      sentences: sentenceTexts,
      progress: progressAt(PIPELINE_STAGE.TOPIC_RANGES, 0, 0),
      ...(record?.topic_range_chunks ? { topic_range_chunks: null } : {}),
    });
    await runtime.update({
      ...doneTransition({ done: 0, total: 0, summariesDisabled: runtime.summariesDisabled }),
      topics: [],
      topic_summaries: {},
    });
    return { topics: null, sentenceTexts };
  }

  const groups = decide
    ? await splitWithDecisions({
        runtime,
        record,
        text,
        sentenceObjs,
        sentenceTexts,
        decide,
        callLLMWithRetry,
        dependencies,
        decisionOptions,
      })
    : await splitTopicRanges({
        runtime,
        sentenceTexts,
        callLLMWithRetry,
        dependencies,
        readCheckpoint: (chunks) => dependencies.readCheckpoint(record, chunks),
        onPrepared: async (_chunks, checkpoint) => {
          await runtime.update({
            sentences: sentenceTexts,
            progress: progressAt(PIPELINE_STAGE.TOPIC_RANGES, 0, sentenceTexts.length),
            ...(record?.topic_range_chunks && !checkpoint ? { topic_range_chunks: null } : {}),
          });
        },
        saveCheckpoint: (chunkStates, sentenceCount, error) =>
          dependencies.saveCheckpoint(runtime, record, chunkStates, sentenceCount, error),
      });

  const topics = groupsToTopics(groups);
  await runtime.update({
    topics,
    // Clear the chunk checkpoint with the final content write.
    topic_range_chunks: null,
    // Tie the resumable topic checkpoint to this content revision.
    summaryCheckpointContentRevision: record.contentRevision,
    summaryCheckpointPreferContentLanguage: runtime.preferContentLanguage === true,
    ...summarizingTransition({ total: topics.length, clearError: false }),
  });

  return { topics, sentenceTexts };
}
