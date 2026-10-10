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
import { runFailFastStage } from './failFastStage.js';

/**
 * Decision-API split: the decision model places range boundaries, then the
 * completion LLM names each range. Completed gaps and labels are checkpointed.
 * @param {object} input Stage capabilities and source snapshot.
 */
export async function splitDecisionTopicRanges(input) {
  return runFailFastStage(input.runtime, input.parallelMap, (runtime, parallelMap) =>
    splitDecisionRanges({ ...input, runtime, checkpointRuntime: input.runtime, parallelMap }),
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
  parallelMap,
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
  const boundaries = await decideTopicBoundaries({
    decide,
    sentences: sentenceObjs,
    text,
    runtime,
    parallelMap,
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
    parallelMap,
    checkpoint,
  });
}
