import { topicLabelKey } from './topicParser.js';
import { getResplitTextChunkMaxChars, MAX_TAGGED_CHARS } from './pipelineConfig.js';
import { defaultTopicRangeDependencies } from './topicRangeDependencies.js';
import { splitTopicRanges } from './topicRangeSplit.js';
import { splitTopicPath } from '../../shared/runtime/topicPath.js';

// Deepest topic hierarchy the pipeline produces; replacement paths must fit.
const MAX_TOPIC_PATH_LEVELS = 5;

// The prompt requires full paths. Preserve the saved ancestors' spelling; an
// invalid path leaves only its own group at the selected topic.
function rootResplitPath(returnedPath, parentPath) {
  const ancestors = parentPath.slice(0, -1);
  if (
    returnedPath.length <= ancestors.length ||
    returnedPath.length > MAX_TOPIC_PATH_LEVELS ||
    topicLabelKey(returnedPath.slice(0, ancestors.length)) !== topicLabelKey(ancestors)
  ) {
    return parentPath;
  }
  return [...ancestors, ...returnedPath.slice(ancestors.length)];
}

/**
 * Split one selected saved range through the shared topic splitter.
 * @param {PipelineRuntime} runtime Pipeline runtime.
 * @param {{label: string[], start: number, end: number}} segment Saved inclusive range.
 * @param {string[]} sentenceTexts Full saved sentence source.
 * @param {Function} callLLMWithRetry Provider request function.
 * @param {object} [options]
 * @param {object} [options.dependencies] Shared splitter dependencies.
 * @returns {Promise<object[]>} Groups with article-absolute, zero-based ranges.
 */
export async function resplitTopicRange(
  runtime,
  segment,
  sentenceTexts,
  callLLMWithRetry,
  { dependencies = defaultTopicRangeDependencies } = {},
) {
  const parentPath = Array.isArray(segment.label) ? segment.label : splitTopicPath(segment.label);
  if (!parentPath.length || parentPath.length > MAX_TOPIC_PATH_LEVELS) {
    throw new Error('The selected topic path must contain one to five levels.');
  }
  const parentPathText = parentPath.join('>');
  const maxTextChunkChars = getResplitTextChunkMaxChars(
    runtime.maxTextChunkChars ?? MAX_TAGGED_CHARS,
    parentPathText,
    runtime.preferContentLanguage,
  );
  if (maxTextChunkChars <= 0) {
    throw new Error('The selected topic path leaves no room for source text in the request.');
  }
  const localGroups = await splitTopicRanges({
    runtime,
    sentenceTexts: sentenceTexts.slice(segment.start, segment.end + 1),
    callLLMWithRetry,
    dependencies,
    parentPath: parentPathText,
    maxTextChunkChars,
  });

  const byLabel = new Map();
  for (const group of localGroups) {
    const returnedPath = Array.isArray(group.label) ? group.label : splitTopicPath(group.label);
    const label = rootResplitPath(returnedPath, parentPath);
    const key = topicLabelKey(label);
    if (!byLabel.has(key)) byLabel.set(key, { label, ranges: [] });
    for (const range of group.ranges) {
      byLabel.get(key).ranges.push({
        start: range.start + segment.start,
        end: range.end + segment.start,
      });
    }
  }
  return [...byLabel.values()];
}
