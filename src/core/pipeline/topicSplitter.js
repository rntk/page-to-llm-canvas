import { createTopicRangeDependencies } from './topicRangeDependencies.js';
import { splitTopicRanges } from './topicRangeSplit.js';
import { splitDecisionTopicRanges } from './decisionTopicSplit.js';
import { parallelMap as defaultParallelMap } from '../llm/concurrency.js';
import { TOPIC_SPLITTER_KINDS } from '../../shared/runtime/telemetry.js';

/**
 * A primary splitter consumes prepared source and returns labelled groups with
 * zero-based inclusive sentence ranges. Strategies own intermediate checkpoints;
 * the topic stage owns source preparation, final writes, and lifecycle transitions.
 * @typedef {object} TopicSplitter
 * @property {string} kind One of `TOPIC_SPLITTER_KINDS`.
 * @property {object} diagnostics Log-safe strategy description.
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
    kind: TOPIC_SPLITTER_KINDS.COMPLETION,
    diagnostics: { topicSplitter: TOPIC_SPLITTER_KINDS.COMPLETION },
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
 * @param {object} options Request capabilities and decision policy.
 * @param {Function} options.decide Decision request bound to the selected provider.
 * @param {Function} options.callLLMWithRetry Completion request used for labels.
 * @param {{contextWindowTokens?: number, inputFingerprint?: string}} [options.decisionOptions]
 *   Request budget and provider identity for checkpoint reuse.
 * @param {object} [options.diagnostics] Log-safe provider description.
 * @param {{parallelMap?: Function}} [options.dependencies] Execution override.
 * @returns {TopicSplitter}
 */
export function createDecisionTopicSplitter({
  decide,
  callLLMWithRetry,
  decisionOptions,
  diagnostics,
  dependencies: { parallelMap = defaultParallelMap } = {},
}) {
  return {
    kind: TOPIC_SPLITTER_KINDS.DECISION,
    diagnostics: { topicSplitter: TOPIC_SPLITTER_KINDS.DECISION, ...diagnostics },
    split: (input) =>
      splitDecisionTopicRanges({
        ...input,
        decide,
        callLLMWithRetry,
        decisionOptions,
        parallelMap,
      }),
  };
}
