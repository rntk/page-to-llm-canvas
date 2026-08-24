/**
 * Pure path and summary utilities shared by TopicHierarchyView.
 */

import { formatTopicPath, joinTopicPath, splitTopicPath } from '../shared/runtime/topicPath.js';

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
