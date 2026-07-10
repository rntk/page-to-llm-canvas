/**
 * Pure helpers for the topic hierarchy and its source-sentence mappings.
 *
 * Topic names encode their hierarchy as paths such as "A > B > C".
 */

/**
 * Split a hierarchical topic path into normalized path segments.
 *
 * @param {string} name
 * @returns {string[]}
 */
export function splitTopicPath(name) {
  return String(name || '')
    .split('>')
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Calculate the deepest zero-based level among the supplied topics.
 *
 * @param {Array<{name: string}>} topics
 * @returns {number}
 */
export function getMaxTopicLevel(topics) {
  if (!Array.isArray(topics) || topics.length === 0) return 0;
  let max = 0;
  for (const topic of topics) {
    const depth = splitTopicPath(topic.name).length - 1;
    if (depth > max) max = depth;
  }
  return max;
}

/**
 * Extract positive, one-based sentence numbers from a topic.
 *
 * @param {{sentences?: number[], sentenceIndices?: number[], ranges?: Array<{sentence_start?: number, sentence_end?: number}>}} topic
 * @returns {number[]}
 */
export function getTopicSentenceNumbers(topic) {
  const explicitSentences = Array.isArray(topic?.sentenceIndices)
    ? topic.sentenceIndices
    : topic?.sentences;
  if (Array.isArray(explicitSentences) && explicitSentences.length > 0) {
    return explicitSentences
      .filter((value) => Number.isInteger(value) && value > 0)
      .sort((left, right) => left - right);
  }

  if (!Array.isArray(topic?.ranges)) return [];

  /** @type {Set<number>} */
  const sentenceNumbers = new Set();
  topic.ranges.forEach((range) => {
    const start = Number(range?.sentence_start);
    const end = Number(range?.sentence_end ?? range?.sentence_start);
    if (!Number.isInteger(start) || !Number.isInteger(end)) return;
    const min = Math.max(1, Math.min(start, end));
    const max = Math.max(start, end);
    for (let sentence = min; sentence <= max; sentence += 1) {
      sentenceNumbers.add(sentence);
    }
  });

  return Array.from(sentenceNumbers).sort((left, right) => left - right);
}

/**
 * Extract sentence numbers while preserving zero-based values used by legacy
 * hierarchy records.
 *
 * @param {{sentences?: number[], sentenceIndices?: number[], ranges?: Array<{sentence_start?: number, sentence_end?: number}>}} topic
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
 * Build a lookup from canonical topic path to the sentence numbers covered by
 * that path and all of its descendants.
 *
 * @param {Array<{name: string}>} topics
 * @returns {Map<string, Set<number>>}
 */
export function buildTopicSentenceIndex(topics) {
  /** @type {Map<string, Set<number>>} */
  const index = new Map();
  if (!Array.isArray(topics) || topics.length === 0) return index;

  for (const topic of topics) {
    const parts = splitTopicPath(topic?.name);
    if (parts.length === 0) continue;

    const sentenceNumbers = getTopicSentenceNumbers(topic);
    if (sentenceNumbers.length === 0) continue;

    for (let depth = 1; depth <= parts.length; depth += 1) {
      const path = parts.slice(0, depth).join(' > ');
      const pathSentences = index.get(path) || new Set();
      for (const sentenceNumber of sentenceNumbers) {
        pathSentences.add(sentenceNumber);
      }
      index.set(path, pathSentences);
    }
  }

  return index;
}

/**
 * Split sorted sentence numbers into contiguous runs.
 *
 * @param {number[]} sentenceNumbers
 * @returns {number[][]}
 */
export function splitSentenceRuns(sentenceNumbers) {
  if (sentenceNumbers.length === 0) return [];

  /** @type {number[][]} */
  const runs = [];
  let currentRun = [sentenceNumbers[0]];

  for (let index = 1; index < sentenceNumbers.length; index += 1) {
    const sentenceNumber = sentenceNumbers[index];
    const previousSentenceNumber = sentenceNumbers[index - 1];
    if (sentenceNumber === previousSentenceNumber + 1) {
      currentRun.push(sentenceNumber);
    } else {
      runs.push(currentRun);
      currentRun = [sentenceNumber];
    }
  }

  runs.push(currentRun);
  return runs;
}
