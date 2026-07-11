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
 * Resolve a range's raw end value, falling back to its start when the end is
 * missing (`null`/`undefined`/`''`). Empty string is common in serialized
 * records, and `Number('')` coerces to `0`, so it must be treated as absent
 * rather than passed straight to `Number()`.
 *
 * @param {{sentence_start?: number, sentence_end?: number}} range
 * @returns {number}
 */
function resolveRangeEnd(range) {
  const rawEnd = range?.sentence_end;
  return rawEnd === null || rawEnd === undefined || rawEnd === '' ? range?.sentence_start : rawEnd;
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
 * Compute the deepest topic level present in a record, considering both the
 * topic list (depth from `name` path) and the `topic_summary_index` (each
 * entry's explicit `level`, or its path depth when absent). Drives the rail's
 * level selector, so summary-only levels count even when no topic reaches them.
 *
 * @param {{topics?: Array<{name?: string}>, topic_summary_index?: Record<string, {level?: number}>}} record
 * @returns {number} The maximum 0-based level.
 */
export function computeMaxTopicLevelForRecord(record) {
  let maxLevel = 0;
  const topics = Array.isArray(record?.topics) ? record.topics : [];
  for (const topic of topics) {
    const depth = splitTopicPath(topic.name).length - 1;
    if (depth > maxLevel) maxLevel = depth;
  }
  const index = record?.topic_summary_index;
  if (index && typeof index === 'object') {
    for (const [rawPath, entry] of Object.entries(index)) {
      if (!rawPath) continue;
      const parts = splitTopicPath(rawPath);
      const indexEntry = entry && typeof entry === 'object' ? entry : {};
      const level = typeof indexEntry.level === 'number' ? indexEntry.level : parts.length - 1;
      if (level > maxLevel) maxLevel = level;
    }
  }
  return maxLevel;
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
    const end = Number(resolveRangeEnd(range));
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
    const end = Number(resolveRangeEnd(range));
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
