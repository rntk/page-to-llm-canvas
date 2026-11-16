import { formatTopicPath, splitTopicPath } from '../shared/runtime/topicPath.js';
import { sortedUnique } from '../shared/runtime/sortedUnique.js';

/**
 * Cross-column invariant: a child card never extends outside its parent card.
 *
 * Columns are resolved one level at a time against their own neighbours, so a
 * parent can be clipped or compacted while its child column has room, leaving the
 * child taller than its parent. This runs after each column step and clamps
 * children top-down, so grandchildren clamp to already-clamped children.
 *
 * A child's run lies inside one parent run, so the parent is the parent-path card
 * with the greatest `startSentence` not after the child's. Cards without sentence
 * positions use the sole parent card on that path, if unique.
 *
 * Clamping never shrinks a card below `minHeight` (or the parent's height, if
 * smaller) and prefers sliding the card inside the parent over cutting it down.
 * Overlap that reappears among siblings is expected; the dense rail layers by z-index.
 *
 * @template {{fullPath: string, levelIndex: number, top: number, height: number, startSentence?: number, endSentence?: number}} T
 * @param {T[]} cards
 * @param {number} minHeight
 * @returns {T[]} Same cards in the same order; changed cards are replaced by clamped copies.
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

  const levels = sortedUnique(cards.map((card) => card.levelIndex));
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
    // Mostly outside the parent: slide it to the nearest edge rather than leave a sliver.
    bottom = Math.min(parentBottom, Math.max(bottom, top + floor));
    top = Math.max(parentTop, bottom - floor);
  }
  return { ...card, top, height: bottom - top };
}
