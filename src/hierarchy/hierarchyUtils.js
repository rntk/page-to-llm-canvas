import { getTopicSentenceNumbers } from '../topicCards.js';

/**
 * Get sentence numbers from a topic, preserving zero if present.
 * @param {object} topic
 * @returns {number[]}
 */
export function getTopicSentenceNumbersRaw(topic) {
  const explicitSentences = Array.isArray(topic?.sentenceIndices)
    ? topic.sentenceIndices
    : topic?.sentences;
  if (Array.isArray(explicitSentences) && explicitSentences.length > 0) {
    return explicitSentences
      .filter((value) => Number.isInteger(value) && value >= 0)
      .sort((left, right) => left - right);
  }

  if (!Array.isArray(topic?.ranges)) return [];

  const sentenceNumbers = new Set();
  topic.ranges.forEach((range) => {
    const start = Number(range?.sentence_start);
    const end = Number(range?.sentence_end ?? range?.sentence_start);
    if (!Number.isInteger(start) || !Number.isInteger(end)) return;
    const min = Math.max(0, Math.min(start, end));
    const max = Math.max(start, end);
    for (let sentence = min; sentence <= max; sentence += 1) {
      sentenceNumbers.add(sentence);
    }
  });

  return Array.from(sentenceNumbers).sort((left, right) => left - right);
}

/**
 * Collect all sentence numbers for a topic tree entry and its descendants.
 * Returns a sorted, deduplicated array of 1-based sentence numbers (or 0-based if preserveZero is true).
 *
 * @param {{ node: { topic: object|null }, children: Map<string, any> }} entry
 * @param {{ preserveZero?: boolean }} [options]
 * @returns {number[]}
 */
export function getSentencesForNode(entry, { preserveZero = false } = {}) {
  const sentenceNumbers = new Set();
  const traverse = (nodeEntry) => {
    if (nodeEntry.node.topic) {
      const nums = preserveZero
        ? getTopicSentenceNumbersRaw(nodeEntry.node.topic)
        : getTopicSentenceNumbers(nodeEntry.node.topic);
      nums.forEach((num) => sentenceNumbers.add(num));
    }
    if (nodeEntry.children) {
      for (const child of nodeEntry.children.values()) {
        traverse(child);
      }
    }
  };
  traverse(entry);
  return Array.from(sentenceNumbers).sort((a, b) => a - b);
}
