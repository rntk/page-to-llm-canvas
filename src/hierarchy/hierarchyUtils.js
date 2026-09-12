import { getTopicSentenceNumbers } from '../domain/topicDomain.js';
import { formatTopicPath, joinTopicPath, splitTopicPath } from '../shared/runtime/topicPath.js';

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

/**
 * Path and summary utilities shared by TopicHierarchyView.
 */

export function normalizeTopicPath(path) {
  return joinTopicPath(splitTopicPath(path));
}

export function spacedTopicPath(path) {
  return formatTopicPath(splitTopicPath(path));
}

function getSummaryText(summary) {
  if (!summary || !Array.isArray(summary.runs)) return '';
  return summary.runs
    .map((run) => (run && typeof run.text === 'string' ? run.text.trim() : ''))
    .filter(Boolean)
    .join(' ');
}

/**
 * Build a lookup Map from normalised topic path to summary text.
 * @param {object|null} topicSummaryIndex
 * @returns {Map<string, string>}
 */
export function buildSummaryLookup(topicSummaryIndex) {
  const lookup = new Map();
  const addSummary = (path, summary) => {
    const text = getSummaryText(summary);
    const normalizedPath = normalizeTopicPath(path);
    if (!text || !normalizedPath) return;
    lookup.set(normalizedPath, text);
  };

  if (topicSummaryIndex && typeof topicSummaryIndex === 'object') {
    Object.entries(topicSummaryIndex).forEach(([path, summary]) => addSummary(path, summary));
  }

  return lookup;
}
