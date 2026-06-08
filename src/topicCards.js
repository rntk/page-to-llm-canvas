/**
 * Pure helpers to derive the topicCards[] shape consumed by
 * CanvasTopicHierarchyRail from a record.topics array.
 *
 * Topic.name has the form "A > B > C" (hierarchy path).
 * Cards are laid out in columns by depth level, matching the frontend canvas.
 */

import { clampScale } from './useCanvasTransform.js';

export const CARD_WIDTH = 240;
export const SUMMARY_CARD_WIDTH = 442;
export const SUMMARY_CARD_MAX_WIDTH = 988;
export const COLUMN_GAP = 18;
export const RAIL_PADDING = 24;

const CARD_HEIGHT = 72;
const CARD_VERTICAL_GAP = 8;
const CARD_TITLE_FONT_SIZE = 12;
const CARD_TITLE_LINE_HEIGHT = 1.2;
const CARD_TITLE_MAX_LINES = 2;
const CARD_VERTICAL_CHROME_PX = 31;

/**
 * Per-card title font size that grows on zoom-out (1/scale, capped at 1) and
 * shrinks if the card is too short to fit two lines.
 *
 * @param {{scale: number, height: number}} params
 * @returns {number}
 */
/**
 * Card width that grows on zoom-out (1/scale, capped at 1) so titles have
 * enough room to render the larger zoom-adjusted font without hyphenation.
 *
 * @param {number} scale
 * @returns {number}
 */
export function getZoomAdjustedCardWidth(scale) {
  return CARD_WIDTH * Math.max(1, 1 / clampScale(scale));
}

export function getZoomAdjustedSummaryCardWidth(scale) {
  return Math.min(SUMMARY_CARD_MAX_WIDTH, SUMMARY_CARD_WIDTH * Math.max(1, 1 / clampScale(scale)));
}

export function getTopicTitleFontSize({ scale, height }) {
  const zoomAdjusted = CARD_TITLE_FONT_SIZE * Math.max(1, 1 / clampScale(scale));
  const availableTitleHeight = Math.max(
    1,
    (Number.isFinite(height) ? height : CARD_HEIGHT) - CARD_VERTICAL_CHROME_PX,
  );
  const heightCapped = availableTitleHeight / (CARD_TITLE_LINE_HEIGHT * CARD_TITLE_MAX_LINES);
  return Math.max(1, Math.min(zoomAdjusted, heightCapped));
}

/**
 * @typedef {Object} TopicTreeNode
 * @property {string} name
 * @property {string} fullPath
 * @property {number} depth
 * @property {Set<number>} sentences
 * @property {Map<string, TopicTreeNode>} children
 */

/**
 * @typedef {Object} SentenceMetric
 * @property {number} top
 * @property {number} bottom
 */

/**
 * Splits a hierarchical topic path string (e.g. "A > B > C") into parts.
 *
 * @param {string} name - The hierarchical path of the topic.
 * @returns {string[]} An array of path segment strings.
 */
export function splitTopicPath(name) {
  return String(name || '')
    .split('>')
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * Calculates the maximum depth/level index among all topics.
 *
 * @param {Array<{name: string}>} topics - Array of topic objects.
 * @returns {number} The maximum depth level (0-based).
 */
export function getMaxTopicLevel(topics) {
  if (!Array.isArray(topics) || topics.length === 0) return 0;
  let max = 0;
  for (const t of topics) {
    const depth = splitTopicPath(t.name).length - 1;
    if (depth > max) max = depth;
  }
  return max;
}

/**
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

/**
 * @param {number[]} sentenceRun
 * @param {Map<number, SentenceMetric>} sentenceMetrics
 * @returns {{top: number, height: number} | null}
 */
function getMeasuredRunLayout(sentenceRun, sentenceMetrics) {
  if (!(sentenceMetrics instanceof Map) || sentenceMetrics.size === 0) {
    return null;
  }

  const metrics = sentenceRun
    .map((sentenceNumber) => sentenceMetrics.get(sentenceNumber))
    .filter(Boolean);
  if (metrics.length === 0) return null;

  const top = Math.min(...metrics.map((metric) => metric.top));
  const bottom = Math.max(...metrics.map((metric) => metric.bottom));
  return {
    top,
    height: Math.max(CARD_HEIGHT, bottom - top),
  };
}

/**
 * Builds the positioned topic card objects for the rail view, showing all
 * hierarchy levels from 0 through selectedLevel in separate columns.
 *
 * @param {Array<{name: string, sentences?: number[], sentenceIndices?: number[], ranges?: Array<{sentence_start?: number, sentence_end?: number}>}>} topics - The topics from the record.
 * @param {number} selectedLevel - The selected maximum hierarchy level to display.
 * @param {Map<number, SentenceMetric>} [sentenceMetrics] - Measured sentence positions, keyed by 1-based sentence number.
 * @returns {Array<{
 *   key: string,
 *   fullPath: string,
 *   displayName: string,
 *   sentenceCount: number,
 *   startSentence: number,
 *   endSentence: number,
 *   top: number,
 *   height: number,
 *   titleFontSize: number,
 *   depth: number,
 *   levelIndex: number,
 *   right: number,
 * }>} Positioned topic cards representing the full hierarchy up to selectedLevel.
 */
export function buildTopicCards(topics, selectedLevel, sentenceMetrics) {
  if (!Array.isArray(topics)) return [];

  const level = Number.isFinite(selectedLevel) ? selectedLevel : 0;

  /**
   * @param {string} name
   * @param {string} fullPath
   * @param {number} depth
   * @returns {TopicTreeNode}
   */
  function createTreeNode(name, fullPath, depth) {
    return {
      name,
      fullPath,
      depth,
      sentences: new Set(),
      children: new Map(),
    };
  }

  const rootNode = createTreeNode('root', '', -1);

  // Build the tree hierarchy up to selected level
  for (const topic of topics) {
    const parts = splitTopicPath(topic.name);
    const limit = Math.min(parts.length, level + 1);

    let curr = rootNode;
    for (let i = 0; i < limit; i += 1) {
      const segment = parts[i];
      const fullPath = parts.slice(0, i + 1).join(' > ');

      if (!curr.children.has(segment)) {
        curr.children.set(segment, createTreeNode(segment, fullPath, i));
      }

      const child = curr.children.get(segment);
      const sentences = getTopicSentenceNumbers(topic);
      for (const s of sentences) {
        if (Number.isInteger(s)) {
          child.sentences.add(s);
        }
      }
      curr = child;
    }
  }

  // Collect all nodes grouped by depth level
  /** @type {Map<number, TopicTreeNode[]>} */
  const nodesByDepth = new Map();

  /**
   * @param {TopicTreeNode} node
   */
  function collect(node) {
    if (node !== rootNode) {
      if (!nodesByDepth.has(node.depth)) nodesByDepth.set(node.depth, []);
      nodesByDepth.get(node.depth).push(node);
    }
    for (const child of node.children.values()) {
      collect(child);
    }
  }
  collect(rootNode);

  /** @type {Map<number, TopicTreeNode[]>} */
  const sortedNodesByDepth = new Map();
  /** @type {Map<string, {top: number, height: number}>} */
  const layoutByPath = new Map();

  for (let depth = 0; depth <= level; depth += 1) {
    const nodes = nodesByDepth.get(depth) || [];
    const sortedNodes = [...nodes].sort((a, b) => {
      const aMin = a.sentences.size ? Math.min(...a.sentences) : Infinity;
      const bMin = b.sentences.size ? Math.min(...b.sentences) : Infinity;
      if (aMin !== bMin) return aMin - bMin;
      return a.name.localeCompare(b.name);
    });

    sortedNodesByDepth.set(depth, sortedNodes);
    sortedNodes.forEach((node, index) => {
      const top = index * (CARD_HEIGHT + CARD_VERTICAL_GAP);
      layoutByPath.set(node.fullPath, { top, height: CARD_HEIGHT });
    });
  }

  for (let depth = level - 1; depth >= 0; depth -= 1) {
    const nodes = sortedNodesByDepth.get(depth) || [];
    nodes.forEach((node) => {
      const childLayouts = Array.from(node.children.values())
        .map((child) => layoutByPath.get(child.fullPath))
        .filter(Boolean);
      if (childLayouts.length === 0) return;

      const top = Math.min(...childLayouts.map((layout) => layout.top));
      const bottom = Math.max(...childLayouts.map((layout) => layout.top + layout.height));
      layoutByPath.set(node.fullPath, {
        top,
        height: Math.max(CARD_HEIGHT, bottom - top),
      });
    });
  }

  const cards = [];

  // Emit cards level by level so each depth occupies its own column
  for (let depth = 0; depth <= level; depth += 1) {
    const nodes = sortedNodesByDepth.get(depth) || [];

    nodes.forEach((node) => {
      const sentenceArray = Array.from(node.sentences).sort((left, right) => left - right);
      const sentenceRuns = splitSentenceRuns(sentenceArray);
      const runs = sentenceRuns.length > 0 ? sentenceRuns : [[]];

      runs.forEach((run, runIndex) => {
        const measuredLayout = getMeasuredRunLayout(run, sentenceMetrics);
        const fallbackLayout = layoutByPath.get(node.fullPath) || {
          top: 0,
          height: CARD_HEIGHT,
        };
        const layout = measuredLayout || fallbackLayout;
        const startSentence = run.length ? Math.min(...run) : 0;
        const endSentence = run.length ? Math.max(...run) : 0;

        cards.push({
          key: `${node.fullPath}#${node.depth}#${runIndex}`,
          fullPath: node.fullPath,
          displayName: node.name,
          sentenceCount: run.length || node.sentences.size,
          startSentence,
          endSentence,
          top: layout.top,
          height: layout.height,
          titleFontSize: CARD_TITLE_FONT_SIZE,
          depth: node.depth,
          levelIndex: node.depth,
          right: RAIL_PADDING + node.depth * (CARD_WIDTH + COLUMN_GAP),
        });
      });
    });
  }

  return cards.sort(
    (left, right) =>
      left.levelIndex - right.levelIndex ||
      left.top - right.top ||
      left.fullPath.localeCompare(right.fullPath),
  );
}
