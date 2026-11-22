import { clampScale } from '../utils/canvasMath.js';
import { LEAF_KIND } from './displayTree.js';

/** Scale below which topic and card titles start counter-scaling to stay legible. */
export const TITLE_ZOOM_THRESHOLD = 0.65;
/** Maximum horizontal container expansion factor when zoomed out. */
export const MAX_CONTAINER_ZOOM = 2;

const TOPIC_LINE_HEIGHT = 1.15;
const CARD_LINE_HEIGHT = 1.25;
const WIDTH_FONT_DIVISOR = 9;
const SLOT_VERTICAL_GAP = 8;
const TOPIC_BORDER_X = 4;
const TOPIC_BORDER_Y = 2;
const TOPIC_PAD_EM_X = 0.7;
const TOPIC_PAD_EM_Y = 0.4;
const CARD_BORDER_X = 2;
const CARD_PAD_EM_X = 0.9;
const CARD_PAD_EM_Y = 0.5;
const CARD_KICKER_EM = 0.85;
const DEFAULT_CARD_WIDTH = 360;
const DEFAULT_CARD_HEIGHT = 240;
const MAX_ZOOM_TITLE_LINES = 3;

/**
 * Font size grows with the share of the article a topic covers, like a word tree.
 * @param {object} node Display node.
 * @param {number} totalSentences Sentences covered by the whole tree.
 */
export function labelSize(node, totalSentences) {
  if (node.kind === LEAF_KIND) return 14;
  const share = totalSentences > 0 ? node.sentences.length / totalSentences : 0;
  return Math.round(15 + 21 * Math.sqrt(Math.min(1, share)));
}

/**
 * Wrap width for a topic label: bigger type gets a wider line, within sane bounds.
 * @param {number} fontSize Title font size in px.
 */
export function topicMaxWidth(fontSize) {
  return Math.max(420, Math.min(680, Math.round(fontSize * 20)));
}

/**
 * Title counter-scale multiplier for a canvas zoom factor. Returns 1 at normal
 * reading zoom (`>= TITLE_ZOOM_THRESHOLD`) and grows smoothly on further zoom-out.
 * @param {number} scale Current canvas scale.
 * @returns {number}
 */
export function titleZoomMultiplier(scale) {
  const clamped = clampScale(scale);
  if (clamped >= TITLE_ZOOM_THRESHOLD) return 1;
  return 1 + (1 / clamped - 1 / TITLE_ZOOM_THRESHOLD);
}

/**
 * Horizontal container-width zoom multiplier for a canvas zoom factor. Returns 1
 * at normal zoom (`>= TITLE_ZOOM_THRESHOLD`) and gently widens nodes, cards, and
 * columns on further zoom-out so larger titles do not break awkwardly.
 * @param {number} scale Current canvas scale.
 * @returns {number}
 */
export function containerZoomMultiplier(scale) {
  const titleZoom = titleZoomMultiplier(scale);
  if (titleZoom <= 1) return 1;
  return Math.min(MAX_CONTAINER_ZOOM, Math.sqrt(titleZoom));
}

/**
 * Compute zoomed-out title slot constraints for one leaf card.
 * @param {object} node Leaf display node.
 * @param {{w: number, h: number}} pos Card size/position rect.
 * @param {number} totalSentences Sentences covered by the whole tree.
 * @returns {{width: number, widthCap: number, heightCap: number, maxFontSize: number, maxLines: number}}
 */
export function leafTitleZoomSlot(node, pos, totalSentences) {
  const baseFont = labelSize(node, totalSentences);
  const cardW = pos.w > 0 ? pos.w : DEFAULT_CARD_WIDTH;
  const cardH = pos.h > 0 ? pos.h : DEFAULT_CARD_HEIGHT;
  const hasKicker = Boolean(node.path && node.path.trim());
  const widthCap = Math.max(1, (cardW - CARD_BORDER_X) / (WIDTH_FONT_DIVISOR + CARD_PAD_EM_X));
  const heightCap = Math.max(
    1,
    cardH / (CARD_LINE_HEIGHT + CARD_PAD_EM_Y + (hasKicker ? CARD_KICKER_EM : 0)),
  );
  const maxFontSize = Math.max(baseFont, Math.min(widthCap * MAX_CONTAINER_ZOOM, heightCap));
  const headingH = Math.max(
    1,
    cardH - maxFontSize * (CARD_PAD_EM_Y + (hasKicker ? CARD_KICKER_EM : 0)),
  );
  const maxLines = Math.max(
    1,
    Math.min(MAX_ZOOM_TITLE_LINES, Math.floor(headingH / (maxFontSize * CARD_LINE_HEIGHT))),
  );
  return { width: cardW, widthCap, heightCap, maxFontSize, maxLines };
}

function computeTopicSlot(entries, index, depth, maxDepth, columnWidths, totalSentences) {
  const { node, pos } = entries[index];
  const baseFont = labelSize(node, totalSentences);
  const hasNextColumn = depth < maxDepth;
  const colW = columnWidths[depth] || 0;
  const slotWidth =
    hasNextColumn && colW > 0
      ? Math.max(pos.w, colW)
      : Math.max(pos.w, colW, topicMaxWidth(baseFont));
  const prev = entries[index - 1];
  const next = entries[index + 1];
  const halfAbove = prev
    ? pos.h / 2 + Math.max(0, pos.top - (prev.pos.top + prev.pos.h)) / 2
    : Infinity;
  const halfBelow = next ? pos.h / 2 + Math.max(0, next.pos.top - (pos.top + pos.h)) / 2 : Infinity;
  const half = Math.min(halfAbove, halfBelow);
  const slotHeight = Number.isFinite(half)
    ? Math.max(pos.h, 2 * half - SLOT_VERTICAL_GAP)
    : Infinity;
  const widthCap = Math.max(
    1,
    (slotWidth - TOPIC_BORDER_X) / (WIDTH_FONT_DIVISOR + TOPIC_PAD_EM_X),
  );
  // Topics with prose include the overview title in their measured height.
  const usableH =
    !node.summary && Number.isFinite(slotHeight)
      ? Math.max(1, slotHeight - TOPIC_BORDER_Y)
      : Infinity;
  const heightCap = Number.isFinite(usableH)
    ? Math.max(1, usableH / (TOPIC_LINE_HEIGHT + TOPIC_PAD_EM_Y))
    : Infinity;
  const maxFontSize = Math.max(baseFont, Math.min(widthCap * MAX_CONTAINER_ZOOM, heightCap));
  const innerH = Number.isFinite(usableH)
    ? Math.max(1, usableH - maxFontSize * TOPIC_PAD_EM_Y)
    : Infinity;
  const maxLines = Number.isFinite(innerH)
    ? Math.max(
        1,
        Math.min(MAX_ZOOM_TITLE_LINES, Math.floor(innerH / (maxFontSize * TOPIC_LINE_HEIGHT))),
      )
    : MAX_ZOOM_TITLE_LINES;
  return { width: slotWidth, widthCap, heightCap, maxFontSize, maxLines };
}

/**
 * Compute per-node width, width/height font caps, peak font size, and line
 * budget for zoomed-out title rendering so grown titles stay inside their
 * widened column and vertical Voronoi slot without overlapping neighboring nodes.
 * @param {object|null} visible Visible display tree.
 * @param {Map<string, {left: number, top: number, w: number, h: number}>|null} positions Placed node rects.
 * @param {number} totalSentences Sentences covered by the whole tree.
 * @returns {Map<string, {width: number, widthCap: number, heightCap: number, maxFontSize: number, maxLines: number}>}
 */
export function titleZoomSlots(visible, positions, totalSentences) {
  const slots = new Map();
  if (!visible || !positions || positions.size === 0) return slots;

  const byDepth = [];
  const columnWidths = [];
  let maxDepth = 0;

  const collect = (node, depth) => {
    const pos = positions.get(node.key);
    if (pos) {
      if (!byDepth[depth]) byDepth[depth] = [];
      byDepth[depth].push({ node, pos });
      columnWidths[depth] = Math.max(columnWidths[depth] || 0, pos.w);
      maxDepth = Math.max(maxDepth, depth);
    }
    node.children.forEach((child) => collect(child, depth + 1));
  };
  collect(visible, 0);

  for (let depth = 0; depth <= maxDepth; depth += 1) {
    const entries = byDepth[depth];
    if (!entries?.length) continue;
    entries.sort((a, b) => a.pos.top - b.pos.top || a.node.key.localeCompare(b.node.key));
    for (let index = 0; index < entries.length; index += 1) {
      const { node, pos } = entries[index];
      slots.set(
        node.key,
        node.kind === LEAF_KIND
          ? leafTitleZoomSlot(node, pos, totalSentences)
          : computeTopicSlot(entries, index, depth, maxDepth, columnWidths, totalSentences),
      );
    }
  }

  return slots;
}
