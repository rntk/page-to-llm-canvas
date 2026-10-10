import { createTopicRangeDependencies } from './topicRangeDependencies.js';
import { splitTopicRanges } from './topicRangeSplit.js';
import { splitDecisionTopicRanges } from './decisionTopicSplit.js';

/**
 * A primary splitter consumes prepared source and returns labelled groups with
 * zero-based inclusive sentence ranges. Strategies own intermediate checkpoints;
 * the topic stage owns source preparation, final writes, and lifecycle transitions.
 * @typedef {object} TopicSplitter
 * @property {'llm'|'decision'} kind Diagnostic strategy name.
 * @property {function(object): Promise<object[]>} split Receives runtime, record,
 *   normalized text, sentenceObjs (offsets/continuations), and sentenceTexts.
 */

/**
 * Compose completion-based splitting with its chunk checkpoint adapter.
 * @param {object} options Completion request and optional stage capabilities.
 * @returns {TopicSplitter}
 */
export function createCompletionTopicSplitter({ callLLMWithRetry, dependencies: overrides }) {
  const dependencies = createTopicRangeDependencies(overrides);
  return {
    kind: 'llm',
    split: ({ runtime, record, sentenceTexts }) =>
      splitTopicRanges({
        runtime,
        sentenceTexts,
        callLLMWithRetry,
        dependencies,
        readCheckpoint: (chunks) => dependencies.readCheckpoint(record, chunks),
        onPrepared: async (_chunks, checkpoint) => {
          if (record?.topic_range_chunks && !checkpoint) {
            await runtime.update({ topic_range_chunks: null });
          }
        },
        saveCheckpoint: (chunkStates, sentenceCount, error) =>
          dependencies.saveCheckpoint(runtime, record, chunkStates, sentenceCount, error),
      }),
  };
}

/**
 * Compose boundary decisions and completion labels into the same splitter contract.
 * @param {object} options Request capabilities, decision policy, and optional dependencies.
 * @returns {TopicSplitter}
 */
export function createDecisionTopicSplitter({
  decide,
  callLLMWithRetry,
  decisionOptions,
  dependencies: overrides,
}) {
  const dependencies = createTopicRangeDependencies(overrides);
  return {
    kind: 'decision',
    split: (input) =>
      splitDecisionTopicRanges({
        ...input,
        decide,
        callLLMWithRetry,
        decisionOptions,
        dependencies,
      }),
  };
}
