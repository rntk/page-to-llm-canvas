import { getTopicSentenceNumbers, getTopicSentenceNumbersRaw } from '../domain/topicDomain.js';

export { getTopicSentenceNumbersRaw } from '../domain/topicDomain.js';

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
