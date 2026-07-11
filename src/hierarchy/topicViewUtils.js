/**
 * Pure path and summary utilities shared by TopicHierarchyView.
 */

import { splitTopicPath } from '../topicDomain.js';

export function normalizeTopicPath(path) {
  return splitTopicPath(path).join('>');
}

export function spacedTopicPath(path) {
  return normalizeTopicPath(path).split('>').join(' > ');
}

export function getSummaryText(summary) {
  if (!summary) return '';
  if (typeof summary === 'string') return summary.trim();
  if (typeof summary !== 'object') return '';

  // Per-run summaries: the hierarchy shows one node per topic, so concatenate the
  // runs (one per non-adjacent occurrence) into a single block of text.
  if (Array.isArray(summary.runs)) {
    return summary.runs
      .map((run) => (run && typeof run.text === 'string' ? run.text.trim() : ''))
      .filter(Boolean)
      .join(' ');
  }

  const text = typeof summary.text === 'string' ? summary.text.trim() : '';
  const bullets = Array.isArray(summary.bullets)
    ? summary.bullets.map((bullet) => (typeof bullet === 'string' ? bullet.trim() : ''))
    : [];

  return [text, ...bullets].filter(Boolean).join(' ');
}

/**
 * Build a lookup Map from normalised topic path to summary text.
 * Both `topicSummaries` and `topicSummaryIndex` are processed; later entries
 * for the same path overwrite earlier ones.
 *
 * @param {object|null} topicSummaries
 * @param {object|null} topicSummaryIndex
 * @returns {Map<string, string>}
 */
export function buildSummaryLookup(topicSummaries, topicSummaryIndex) {
  const lookup = new Map();
  const addSummary = (path, summary) => {
    const text = getSummaryText(summary);
    const normalizedPath = normalizeTopicPath(path);
    if (!text || !normalizedPath) return;
    lookup.set(normalizedPath, text);
    lookup.set(spacedTopicPath(normalizedPath), text);
  };

  if (topicSummaries && typeof topicSummaries === 'object') {
    Object.entries(topicSummaries).forEach(([path, summary]) => addSummary(path, summary));
  }

  if (topicSummaryIndex && typeof topicSummaryIndex === 'object') {
    Object.entries(topicSummaryIndex).forEach(([path, summary]) => addSummary(path, summary));
  }

  return lookup;
}
