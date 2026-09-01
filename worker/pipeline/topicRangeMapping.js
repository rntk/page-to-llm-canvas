import { joinTopicPath } from '../../src/shared/runtime/topicPath.js';

export function rangesToSentenceList(ranges) {
  // Ranges are 0-based inclusive; output a 1-based ordered unique list.
  const set = new Set();
  for (const range of ranges) {
    for (let i = range.start; i <= range.end; i++) set.add(i);
  }
  return Array.from(set)
    .sort((a, b) => a - b)
    .map((i) => i + 1);
}

export function mapTextOffsetToSource(mapping, textOffset) {
  if (textOffset < 0) textOffset = 0;
  if (textOffset >= mapping.length) textOffset = mapping.length - 1;
  return mapping[textOffset];
}

export function groupsToTopics(groups, sentenceObjs, mapping) {
  return groups.map((group) => {
    const name = joinTopicPath(group.label);
    const oneBased = rangesToSentenceList(group.ranges);
    const sentence_spans = oneBased.map((oneIdx) => {
      const sentence = sentenceObjs[oneIdx - 1];
      return {
        sentence: oneIdx,
        start: mapTextOffsetToSource(mapping, sentence.start),
        end: mapTextOffsetToSource(mapping, sentence.end),
      };
    });
    const ranges = group.ranges.map((range) => {
      const startIndex = range.start;
      const endIndex = range.end;
      return {
        sentence_start: startIndex + 1,
        sentence_end: endIndex + 1,
        start: mapTextOffsetToSource(mapping, sentenceObjs[startIndex].start),
        end: mapTextOffsetToSource(mapping, sentenceObjs[endIndex].end),
      };
    });
    return {
      name,
      sentences: oneBased,
      sentence_spans,
      ranges,
      offset_basis: 'captured_text',
    };
  });
}
