import { splitTopicPath } from '../domain/topicDomain.js';

function toReadTopicsSet(readTopics) {
  if (readTopics instanceof Set) return readTopics;
  if (!readTopics) return new Set();
  return new Set(readTopics);
}

export function isTopicRead(topicName, readTopics) {
  if (!topicName) return false;
  const set = toReadTopicsSet(readTopics);
  if (set.size === 0) return false;
  const parts = splitTopicPath(topicName);
  let current = '';
  for (let i = 0; i < parts.length; i += 1) {
    current = i === 0 ? parts[i] : `${current}>${parts[i]}`;
    if (set.has(current)) return true;
  }
  return false;
}
