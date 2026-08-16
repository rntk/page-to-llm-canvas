import { canonicalTopicPath, splitTopicPath } from './topicDomain.js';

/**
 * Normalize persisted or UI-supplied read-topic paths to canonical keys.
 *
 * @param {Set<string> | string[] | null | undefined} readTopics
 * @returns {Set<string>}
 */
export function normalizeReadTopics(readTopics) {
  const normalized = new Set();
  if (!(readTopics instanceof Set) && !Array.isArray(readTopics)) return normalized;

  for (const value of readTopics) {
    const path = canonicalTopicPath(value);
    if (path) normalized.add(path);
  }
  return normalized;
}

export function isTopicRead(topicName, readTopics) {
  if (!topicName) return false;
  const set = normalizeReadTopics(readTopics);
  if (set.size === 0) return false;
  const parts = splitTopicPath(topicName);
  let current = '';
  for (let i = 0; i < parts.length; i += 1) {
    current = i === 0 ? parts[i] : `${current}>${parts[i]}`;
    if (set.has(current)) return true;
  }
  return false;
}
