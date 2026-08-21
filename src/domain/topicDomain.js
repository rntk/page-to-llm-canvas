/**
 * Pure helpers for the topic hierarchy and its source-sentence mappings.
 *
 * Topic names encode their hierarchy as paths such as "A > B > C".
 */

// The delimiter itself is owned by src/shared/runtime/topicPath.js so the
// worker pipeline and the frontend cannot drift apart. splitTopicPath is
// re-exported here because it is part of the topic model's public vocabulary.
import { formatTopicPath, splitTopicPath } from '../shared/runtime/topicPath.js';

export { splitTopicPath };

/**
 * Enforces the canonical topic-summary index entry contract at UI boundaries.
 *
 * @param {string} path
 * @param {unknown} entry
 * @returns {number}
 */
export function requireTopicSummaryLevel(path, entry) {
  if (
    !entry ||
    typeof entry !== 'object' ||
    Array.isArray(entry) ||
    !Number.isInteger(entry.level) ||
    entry.level < 0
  ) {
    throw new TypeError(
      `Invalid topic_summary_index entry for "${path}": level must be a non-negative integer`,
    );
  }
  return entry.level;
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
 * entry's explicit `level`). Drives the rail's level selector, so summary-only
 * levels count even when no topic reaches them.
 *
 * @param {object} record
 * @param {Array<{name: string}>} [record.topics]
 * @param {Record<string, {level: number}>} [record.topic_summary_index]
 * @returns {number} The maximum 0-based level.
 */
export function computeMaxTopicLevelForRecord(record) {
  let maxLevel = getMaxTopicLevel(record?.topics);
  const index = record?.topic_summary_index;
  if (index && typeof index === 'object') {
    for (const [rawPath, entry] of Object.entries(index)) {
      if (!rawPath) continue;
      const level = requireTopicSummaryLevel(rawPath, entry);
      if (level > maxLevel) maxLevel = level;
    }
  }
  return maxLevel;
}

/**
 * Extract positive, one-based sentence numbers from a topic.
 *
 * @param {object} topic
 * @param {number[]} [topic.sentences]
 * @returns {number[]}
 */
export function getTopicSentenceNumbers(topic) {
  if (!Array.isArray(topic?.sentences)) return [];
  return topic.sentences
    .filter((value) => Number.isInteger(value) && value > 0)
    .sort((left, right) => left - right);
}

/**
 * Build a lookup from normalized display path (`A > B`) to the sentence
 * numbers covered by that path and all of its descendants.
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
      const path = formatTopicPath(parts.slice(0, depth));
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
 * Split sentence numbers into contiguous runs. The input is sorted defensively:
 * callers receive sentence lists straight from stored records, which are not
 * guaranteed to be ordered, and an unsorted input would otherwise be split into
 * spurious single-sentence runs.
 *
 * @param {number[]} sentenceNumbers
 * @returns {number[][]}
 */
export function splitSentenceRuns(sentenceNumbers) {
  if (!Array.isArray(sentenceNumbers) || sentenceNumbers.length === 0) return [];
  const sorted = sentenceNumbers.slice().sort((left, right) => left - right);

  /** @type {number[][]} */
  const runs = [];
  let currentRun = [sorted[0]];

  for (let index = 1; index < sorted.length; index += 1) {
    const sentenceNumber = sorted[index];
    const previousSentenceNumber = sorted[index - 1];
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

/**
 * Canonical normalization for the per-run list carried by a topic-summary index
 * entry. Each run becomes `{sentences (sorted), text (trimmed)}`. An entry with
 * no runs (an errored or skipped topic) falls back to positioned but text-less
 * runs derived from its aggregated sentences.
 *
 * Callers own the *policy* applied to the result: some surfaces drop text-less
 * runs, others keep them as placeholders. This helper only normalizes shape.
 *
 * @param {Array<{sentences?: number[], text?: string}>} runs
 * @param {number[]} sourceSentences
 * @returns {Array<{sentences: number[], text: string}>}
 */
export function normalizeSummaryRuns(runs, sourceSentences) {
  if (Array.isArray(runs) && runs.length > 0) {
    return runs.map((run) => ({
      sentences: Array.isArray(run?.sentences)
        ? run.sentences.slice().sort((left, right) => left - right)
        : [],
      text: typeof run?.text === 'string' ? run.text.trim() : '',
    }));
  }
  return splitSentenceRuns(sourceSentences).map((run) => ({ sentences: run, text: '' }));
}

/**
 * @typedef {object} TopicHierarchyNode
 * @property {string} name Last path segment ('root' for the synthetic root).
 * @property {string} fullPath Normalized display path (`A > B > C`; empty for the root).
 * @property {number} depth Zero-based level (-1 for the root).
 * @property {number} order Global creation index, used to restore first-seen order.
 * @property {Set<number>} sentences Sentence numbers of this node and its descendants.
 * @property {Map<string, TopicHierarchyNode>} children Child nodes keyed by segment.
 */

/**
 * Build the shared display-path topic hierarchy tree from a flat topic list,
 * truncated at `maxLevel`. Every hierarchy projection (canvas cards, in-page
 * rail, YouTube rail) derives from this single accumulation of path splitting,
 * level limiting and sentence roll-up.
 *
 * @param {Array<{name: string, sentences?: number[]}>} topics
 * @param {number} maxLevel Deepest zero-based level to include.
 * @returns {TopicHierarchyNode} The synthetic root node.
 */
export function buildTopicHierarchyTree(topics, maxLevel) {
  let nextOrder = 0;
  const createNode = (name, fullPath, depth) => ({
    name,
    fullPath,
    depth,
    order: nextOrder++,
    sentences: new Set(),
    children: new Map(),
  });

  const root = createNode('root', '', -1);
  if (!Array.isArray(topics)) return root;

  const level = Number.isFinite(maxLevel) ? maxLevel : 0;

  for (const topic of topics) {
    const parts = splitTopicPath(topic?.name);
    const limit = Math.min(parts.length, level + 1);
    const sentenceNumbers = getTopicSentenceNumbers(topic);

    let current = root;
    for (let index = 0; index < limit; index += 1) {
      const segment = parts[index];
      if (!current.children.has(segment)) {
        current.children.set(
          segment,
          createNode(segment, formatTopicPath(parts.slice(0, index + 1)), index),
        );
      }
      const child = current.children.get(segment);
      for (const sentenceNumber of sentenceNumbers) {
        child.sentences.add(sentenceNumber);
      }
      current = child;
    }
  }

  return root;
}

/**
 * Flatten a topic hierarchy tree into its nodes, excluding the synthetic root.
 * Nodes come back in the order their paths were first encountered in the topic
 * list, which is the order rail surfaces render them in.
 *
 * @param {TopicHierarchyNode} root
 * @returns {TopicHierarchyNode[]}
 */
export function flattenTopicHierarchy(root) {
  /** @type {TopicHierarchyNode[]} */
  const nodes = [];
  const visit = (node) => {
    for (const child of node.children.values()) {
      nodes.push(child);
      visit(child);
    }
  };
  visit(root);
  return nodes.sort((left, right) => left.order - right.order);
}
