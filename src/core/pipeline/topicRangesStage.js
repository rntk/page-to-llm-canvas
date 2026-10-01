import { normalizeCapturedText } from './capturedText.js';
import { splitSentences } from './sentenceSplitter.js';
import { groupsToTopics } from './topicRangeMapping.js';
import { createTopicRangeDependencies } from './topicRangeDependencies.js';
import { splitTopicRanges } from './topicRangeSplit.js';
import { PIPELINE_STAGE } from '../../shared/runtime/contracts.js';
import {
  doneTransition,
  progressAt,
  resetSummaryCheckpointPatch,
  splittingTransition,
  summarizingTransition,
} from '../../shared/runtime/recordTransitions.js';

/**
 * Cleans the HTML, splits sentences, and runs the LLM topic-ranges stage.
 * Returns topics:null when no sentences were found and the record was finalized.
 *
 * @param {object} input
 * @param {PipelineRuntime} input.runtime
 * @param {object} input.record
 * @param {Function} input.callLLMWithRetry
 * @param {object} [input.dependencies] Telemetry, execution, and checkpoint capabilities.
 */
export async function computeTopics({
  runtime,
  record,
  callLLMWithRetry,
  dependencies: overrides,
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

  const groups = await splitTopicRanges({
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
