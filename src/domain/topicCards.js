/**
 * Pure helpers to derive the topicCards[] shape consumed by
 * CanvasTopicHierarchyRail from a record.topics array.
 *
 * Topic.name has the form "A > B > C" (hierarchy path).
 * Cards are laid out in columns by depth level, matching the frontend canvas.
 */

import { getTopicSentenceNumbers, splitSentenceRuns, splitTopicPath } from './topicDomain.js';
import { clampScale } from '../utils/canvasMath.js';

export const CARD_WIDTH = 240;
export const SUMMARY_CARD_WIDTH = 442;
// The canvas can zoom out to 0.1, so allow the summary card to grow to 10x its
// base width. This keeps its on-screen width readable instead of shrinking it
// into a narrow, excessively tall card at the minimum zoom.
export const SUMMARY_CARD_MAX_WIDTH = 4420;
export const COLUMN_GAP = 18;
export const RAIL_PADDING = 24;

const CARD_HEIGHT = 72;
const CARD_VERTICAL_GAP = 8;
const CARD_MIN_CLAMPED_HEIGHT = 56;
const CARD_TITLE_FONT_SIZE = 12;
const CARD_TITLE_LINE_HEIGHT = 1.2;
const CARD_TITLE_MAX_LINES = 2;
const CARD_COMPACT_TITLE_MAX_LINES = 1;
const CARD_COMPACT_HEIGHT_THRESHOLD = 88;
const CARD_VERTICAL_PADDING_PX = 16;
const CARD_META_LINE_HEIGHT_PX = 12;
const CARD_CONTENT_GAP_PX = 3;

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

function getTitleLineBudget(height) {
  return height < CARD_COMPACT_HEIGHT_THRESHOLD
    ? CARD_COMPACT_TITLE_MAX_LINES
    : CARD_TITLE_MAX_LINES;
}

/**
 * Per-card title font size that grows on zoom-out (1/scale, capped at 1) and
 * shrinks if the card is too short to fit two lines.
 *
 * @param {{scale: number, height: number}} params
 * @returns {number}
 */
export function getTopicTitleFontSize({ scale, height }) {
  const zoomAdjusted = CARD_TITLE_FONT_SIZE * Math.max(1, 1.25 / clampScale(scale) - 0.25);
  const safeHeight = Number.isFinite(height) ? height : CARD_HEIGHT;
  const titleLines = getTitleLineBudget(safeHeight);
  const availableTitleHeight = Math.max(
    1,
    safeHeight - CARD_VERTICAL_PADDING_PX - CARD_META_LINE_HEIGHT_PX - CARD_CONTENT_GAP_PX,
  );
  const heightCapped = availableTitleHeight / (CARD_TITLE_LINE_HEIGHT * titleLines);
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
 * Hard layout invariant: within a column (levelIndex), cards laid out in
 * document order (by start sentence) never overlap vertically.
 *
 * Measured sentence positions can be wrong — e.g. emails with repeated
 * invisible preheader sentences or clipped footers fuzzy-match the wrong DOM
 * text, stretching one card's rect across its neighbours. A card whose extent
 * runs past the next card's top is clipped to end above it; a card overlapped
 * from above is pushed down. The result is always a clean vertical stack.
 *
 * @template {{key: string, levelIndex: number, startSentence: number, top: number, height: number, fullPath: string}} T
 * @param {T[]} cards
 * @returns {T[]}
 */
export function resolveColumnOverlaps(cards) {
  if (!Array.isArray(cards) || cards.length === 0) return cards;

  /** @type {Map<number, T[]>} */
  const cardsByLevel = new Map();
  for (const card of cards) {
    const levelCards = cardsByLevel.get(card.levelIndex) || [];
    levelCards.push(card);
    cardsByLevel.set(card.levelIndex, levelCards);
  }

  /** @type {Map<string, {top: number, height: number}>} */
  const adjustedByKey = new Map();
  for (const levelCards of cardsByLevel.values()) {
    const ordered = [...levelCards].sort(
      (a, b) =>
        a.startSentence - b.startSentence || a.top - b.top || a.fullPath.localeCompare(b.fullPath),
    );

    let prevBottom = -Infinity;
    ordered.forEach((card, index) => {
      const top = Math.max(card.top, prevBottom + CARD_VERTICAL_GAP);
      let bottom = Math.max(card.top + card.height, top + CARD_MIN_CLAMPED_HEIGHT);

      // Clip to the next card's measured top when there is room for at least a
      // minimum-height card; otherwise keep our extent and let the next card
      // be pushed below us on its own iteration.
      const next = ordered[index + 1];
      if (next && next.top - CARD_VERTICAL_GAP >= top + CARD_MIN_CLAMPED_HEIGHT) {
        bottom = Math.min(bottom, next.top - CARD_VERTICAL_GAP);
      }

      prevBottom = bottom;
      adjustedByKey.set(card.key, { top, height: bottom - top });
    });
  }

  return cards.map((card) => {
    const adjusted = adjustedByKey.get(card.key);
    return adjusted ? { ...card, top: adjusted.top, height: adjusted.height } : card;
  });
}

function getPathPrefixes(path) {
  const parts = splitTopicPath(path);
  const prefixes = [];
  for (let depth = 1; depth <= parts.length; depth += 1) {
    prefixes.push(parts.slice(0, depth).join(' > '));
  }
  return prefixes;
}

function addMetricEntry(index, path, entry) {
  const entries = index.get(path) || [];
  entries.push(entry);
  index.set(path, entries);
}

/**
 * Patches topic card positions from measured summary-card bounding rects,
 * then re-runs overlap resolution so the no-overlap column invariant holds.
 *
 * For each topic card the function looks for matching summary metrics using
 * path ancestor/descendant string matching — the same logic used in the
 * App.jsx useMemo. The accumulated bounding box across all matching metrics
 * (filtered by sentence-range overlap) becomes the card's new top/height.
 * Cards without any matching metric are left at their original positions.
 *
 * @param {Array<{key: string, fullPath: string, startSentence: number, endSentence: number, top: number, height: number, levelIndex: number}>} cards
 *   Topic cards as returned by buildTopicCards.
 * @param {Array<{key: string, path: string, startSentence: number}>} allSummaryCards
 *   All summary cards as returned by buildSummaryCards (used for sentence-range overlap check).
 * @param {Map<string, {top: number, height: number}>} summaryMetrics
 *   Map from summary card key to measured {top, height}.
 * @returns {Array} New topic cards with patched positions and overlaps resolved.
 */
export function patchTopicCardsFromSummaryMetrics(cards, allSummaryCards, summaryMetrics) {
  if (!(summaryMetrics instanceof Map) || summaryMetrics.size === 0) {
    return resolveColumnOverlaps(cards);
  }

  const summaryCardMap = new Map(allSummaryCards.map((c) => [c.key, c]));
  const exactMetricsByPath = new Map();
  const metricsByAncestorPath = new Map();

  for (const [key, metric] of summaryMetrics) {
    const path = key.split('#')[0];
    const entry = { key, metric, summaryCard: summaryCardMap.get(key) };
    addMetricEntry(exactMetricsByPath, path, entry);

    for (const prefix of getPathPrefixes(path)) {
      addMetricEntry(metricsByAncestorPath, prefix, entry);
    }
  }

  function getCandidateMetrics(card) {
    const candidatesByKey = new Map();

    for (const entry of metricsByAncestorPath.get(card.fullPath) || []) {
      candidatesByKey.set(entry.key, entry);
    }

    const ancestorPaths = getPathPrefixes(card.fullPath);
    for (let index = 0; index < ancestorPaths.length - 1; index += 1) {
      for (const entry of exactMetricsByPath.get(ancestorPaths[index]) || []) {
        candidatesByKey.set(entry.key, entry);
      }
    }

    return candidatesByKey.values();
  }

  const patchedCards = cards.map((card) => {
    // Exact key match takes priority.
    const direct = summaryMetrics.get(card.key);
    if (direct) {
      return { ...card, top: direct.top, height: direct.height };
    }

    let top = Infinity;
    let bottom = -Infinity;
    for (const { metric, summaryCard } of getCandidateMetrics(card)) {
      if (summaryCard) {
        const start = summaryCard.startSentence;
        const hasOverlap =
          (start >= card.startSentence && start <= card.endSentence) ||
          (card.startSentence === 0 && card.endSentence === 0);
        if (!hasOverlap) {
          continue;
        }
      }
      if (metric.top < top) top = metric.top;
      if (metric.top + metric.height > bottom) bottom = metric.top + metric.height;
    }
    if (Number.isFinite(top) && Number.isFinite(bottom)) {
      return { ...card, top, height: Math.max(72, bottom - top) };
    }
    return card;
  });

  return resolveColumnOverlaps(patchedCards);
}

/**
 * Builds the positioned topic card objects for the rail view, showing all
 * hierarchy levels from 0 through selectedLevel in separate columns.
 *
 * @param {Array<{name: string, sentences?: number[]}>} topics - The topics from the record.
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
    const sentences = getTopicSentenceNumbers(topic);

    let curr = rootNode;
    for (let i = 0; i < limit; i += 1) {
      const segment = parts[i];
      const fullPath = parts.slice(0, i + 1).join(' > ');

      if (!curr.children.has(segment)) {
        curr.children.set(segment, createTreeNode(segment, fullPath, i));
      }

      const child = curr.children.get(segment);
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

  // A topic with non-contiguous sentences (e.g. a newsletter header/footer
  // wrapping the body) renders as one card per contiguous run, so fallback
  // layouts must be computed per run — sharing a per-node layout would stack
  // the runs on top of each other and stretch them across the gap.
  /** @type {Map<number, Array<{node: TopicTreeNode, run: number[], runIndex: number, runKey: string, start: number, end: number}>>} */
  const runEntriesByDepth = new Map();
  /** @type {Map<string, Array<{runKey: string, start: number, end: number}>>} */
  const runEntriesByPath = new Map();
  /** @type {Map<string, {top: number, height: number}>} */
  const layoutByRunKey = new Map();

  for (let depth = 0; depth <= level; depth += 1) {
    const nodes = nodesByDepth.get(depth) || [];
    const runEntries = nodes.flatMap((node) => {
      const sentenceArray = Array.from(node.sentences).sort((left, right) => left - right);
      const sentenceRuns = splitSentenceRuns(sentenceArray);
      const runs = sentenceRuns.length > 0 ? sentenceRuns : [[]];
      const entries = runs.map((run, runIndex) => ({
        node,
        run,
        runIndex,
        runKey: `${node.fullPath}#${runIndex}`,
        start: run.length ? run[0] : Infinity,
        end: run.length ? run[run.length - 1] : Infinity,
      }));
      runEntriesByPath.set(node.fullPath, entries);
      return entries;
    });

    runEntries.sort((a, b) => a.start - b.start || a.node.name.localeCompare(b.node.name));
    runEntriesByDepth.set(depth, runEntries);
    runEntries.forEach((entry, index) => {
      const top = index * (CARD_HEIGHT + CARD_VERTICAL_GAP);
      layoutByRunKey.set(entry.runKey, { top, height: CARD_HEIGHT });
    });
  }

  for (let depth = level - 1; depth >= 0; depth -= 1) {
    const runEntries = runEntriesByDepth.get(depth) || [];
    runEntries.forEach((entry) => {
      // Child sentences are a subset of the parent's, and parent runs are
      // maximal contiguous blocks, so each child run falls entirely inside
      // exactly one parent run.
      const childLayouts = Array.from(entry.node.children.values())
        .flatMap((child) => runEntriesByPath.get(child.fullPath) || [])
        .filter((childEntry) => childEntry.start >= entry.start && childEntry.end <= entry.end)
        .map((childEntry) => layoutByRunKey.get(childEntry.runKey))
        .filter(Boolean);
      if (childLayouts.length === 0) return;

      const top = Math.min(...childLayouts.map((layout) => layout.top));
      const bottom = Math.max(...childLayouts.map((layout) => layout.top + layout.height));
      layoutByRunKey.set(entry.runKey, {
        top,
        height: Math.max(CARD_HEIGHT, bottom - top),
      });
    });
  }

  const cards = [];

  // Emit cards level by level so each depth occupies its own column
  for (let depth = 0; depth <= level; depth += 1) {
    const runEntries = runEntriesByDepth.get(depth) || [];

    runEntries.forEach(({ node, run, runIndex, runKey }) => {
      const measuredLayout = getMeasuredRunLayout(run, sentenceMetrics);
      const fallbackLayout = layoutByRunKey.get(runKey) || {
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
  }

  return resolveColumnOverlaps(cards).sort(
    (left, right) =>
      left.levelIndex - right.levelIndex ||
      left.top - right.top ||
      left.fullPath.localeCompare(right.fullPath),
  );
}
