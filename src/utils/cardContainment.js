import { formatTopicPath, splitTopicPath } from '../shared/runtime/topicPath.js';

/**
 * Cross-column layout invariant: a child topic card never extends outside the
 * parent card it belongs to.
 *
 * Column layouts (resolveColumnOverlaps, adjustCrowdedLevelCards) are resolved
 * one level at a time, each against its own neighbours only. A parent may be
 * clipped to clear its next sibling or compacted because its column is crowded
 * while the child column has room, so a child that started with the very same
 * measured box can end up taller than its parent and stick out below it. This
 * pass runs after any per-column step and pulls each child back inside its
 * parent, walking levels top-down so a grandchild is clamped to the already
 * clamped child.
 *
 * A child's run always lies inside exactly one parent run (child sentences are
 * a subset of the parent's and runs are maximal contiguous blocks), so the
 * containing parent is the parent-path card with the greatest `startSentence`
 * not after the child's. Cards without sentence positions fall back to the
 * sole parent card of that path, if there is one, and are otherwise left as
 * they are.
 *
 * Clamping keeps the card legible: it never shrinks below `minHeight` (or the
 * parent's own height, if that is smaller), preferring to slide the card up
 * inside the parent over cutting it down. The overlap that can reintroduce
 * within the child column is expected — the rail's dense layout layers
 * crowded cards by z-index.
 *
 * @template {{fullPath: string, levelIndex: number, top: number, height: number, startSentence?: number, endSentence?: number}} T
 * @param {T[]} cards
 * @param {number} minHeight
 * @returns {T[]} the same cards, in the same order; a card is replaced by a
 *   clamped copy only when its box actually changed
 */
export function clampCardsToParents(cards, minHeight) {
  if (!Array.isArray(cards) || cards.length === 0) return cards;

  /** @type {Map<number, Map<string, T[]>>} level -> fullPath -> resolved cards */
  const resolvedByLevel = new Map();
  const remember = (card) => {
    let byPath = resolvedByLevel.get(card.levelIndex);
    if (!byPath) {
      byPath = new Map();
      resolvedByLevel.set(card.levelIndex, byPath);
    }
    const list = byPath.get(card.fullPath) || [];
    list.push(card);
    byPath.set(card.fullPath, list);
  };

  const levels = [...new Set(cards.map((card) => card.levelIndex))].sort((a, b) => a - b);
  const result = cards.slice();
  for (const level of levels) {
    for (let index = 0; index < result.length; index += 1) {
      const card = result[index];
      if (card.levelIndex !== level) continue;
      const parent = findParentCard(card, resolvedByLevel.get(level - 1));
      const clamped = parent ? clampToParent(card, parent, minHeight) : card;
      result[index] = clamped;
      remember(clamped);
    }
  }
  return result;
}

function getParentPath(fullPath) {
  const parts = splitTopicPath(fullPath);
  return parts.length > 1 ? formatTopicPath(parts.slice(0, -1)) : null;
}

function findParentCard(card, parentsByPath) {
  if (!parentsByPath) return null;
  const parentPath = getParentPath(card.fullPath);
  if (parentPath === null) return null;
  const candidates = parentsByPath.get(parentPath);
  if (!candidates || candidates.length === 0) return null;

  if (!Number.isFinite(card.startSentence)) {
    return candidates.length === 1 ? candidates[0] : null;
  }
  let parent = null;
  for (const candidate of candidates) {
    if (!Number.isFinite(candidate.startSentence) || candidate.startSentence > card.startSentence) {
      continue;
    }
    if (Number.isFinite(candidate.endSentence) && candidate.endSentence < card.startSentence) {
      continue;
    }
    if (!parent || candidate.startSentence > parent.startSentence) parent = candidate;
  }
  return parent;
}

function clampToParent(card, parent, minHeight) {
  const parentTop = parent.top;
  const parentBottom = parent.top + parent.height;
  const cardBottom = card.top + card.height;
  if (card.top >= parentTop && cardBottom <= parentBottom) return card;

  const floor = Math.min(minHeight, parent.height);
  let top = Math.max(card.top, parentTop);
  let bottom = Math.min(cardBottom, parentBottom);
  if (bottom - top < floor) {
    // Too little of the card lies inside the parent (it was measured mostly
    // above or below it): slide it up to the parent's bottom edge, or down
    // to its top edge, rather than leaving a sliver.
    bottom = Math.min(parentBottom, Math.max(bottom, top + floor));
    top = Math.max(parentTop, bottom - floor);
  }
  return { ...card, top, height: bottom - top };
}
