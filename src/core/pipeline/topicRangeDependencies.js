import { recordParserMetric as defaultRecordParserMetric } from '../metrics/parser.js';
import {
  createResplitRunStats as defaultCreateResplitRunStats,
  noteResplitOutcome as defaultNoteResplitOutcome,
  recordResplitRun as defaultRecordResplitRun,
} from '../metrics/resplit.js';
import { parallelMap as defaultParallelMap } from '../llm/concurrency.js';
import {
  readTopicRangeChunkCheckpoint,
  saveTopicRangeChunkCheckpoint,
} from './topicRangeCheckpoint.js';

export const defaultTopicRangeDependencies = Object.freeze({
  parallelMap: defaultParallelMap,
  recordParserMetric: defaultRecordParserMetric,
  recordResplitRun: defaultRecordResplitRun,
  createResplitRunStats: defaultCreateResplitRunStats,
  noteResplitOutcome: defaultNoteResplitOutcome,
  readCheckpoint: readTopicRangeChunkCheckpoint,
  saveCheckpoint: saveTopicRangeChunkCheckpoint,
});

/**
 * Creates the flat capability object used by the topic-ranging coordinator.
 * @param {object} [overrides] Individual stage capabilities to replace.
 * @returns {object} Complete topic-ranging dependencies.
 */
export function createTopicRangeDependencies(overrides = {}) {
  return { ...defaultTopicRangeDependencies, ...overrides };
}
