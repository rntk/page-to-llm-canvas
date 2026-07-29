import { getTopicSentenceNumbers } from '../domain/topicDomain.js';

/**
 * Collect all sentence numbers for a topic tree entry and its descendants.
 * Returns a sorted, deduplicated array of one-based sentence numbers.
 *
 * @param {{ node: { topic: object|null }, children: Map<string, any> }} entry
 * @returns {number[]}
 */
export function getSentencesForNode(entry) {
  const sentenceNumbers = new Set();
  const traverse = (nodeEntry) => {
    if (nodeEntry.node.topic) {
      const nums = getTopicSentenceNumbers(nodeEntry.node.topic);
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
