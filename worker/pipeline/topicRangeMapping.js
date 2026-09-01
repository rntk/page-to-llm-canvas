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

export function groupsToTopics(groups) {
  return groups.map((group) => ({
    name: joinTopicPath(group.label),
    sentences: rangesToSentenceList(group.ranges),
  }));
}
