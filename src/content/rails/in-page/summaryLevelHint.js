import { gapToSpans } from '../shared/levelHint.js';

// A cursor this close to a card box still counts as covered.
export const SUMMARY_LEVEL_HINT_TOLERANCE_PX = 24;

/**
 * Distance, per level, from the summary cursor to the nearest card box.
 *
 * @param {Map<number, Array<{box: {top: number, height: number}}>>} levelCards
 * @param {number} relativeY Cursor position in card-box space.
 * @returns {Map<number, number>} Level to gap in px (0 when covered).
 */
export function gapsFromLevelCards(levelCards, relativeY) {
  const gaps = new Map();
  if (!(levelCards instanceof Map)) return gaps;
  for (const [level, cards] of levelCards) {
    const spans = (cards || []).map(({ box }) => ({ start: box.top, end: box.top + box.height }));
    gaps.set(level, gapToSpans(spans, relativeY));
  }
  return gaps;
}

// Allocation-free gap to the nearest box; same semantics as `gapToSpans` over
// [top, top + height) spans.
function gapToBoxes(cards, position) {
  let best = Infinity;
  if (!Array.isArray(cards) || !Number.isFinite(position)) return best;
  for (const card of cards) {
    const box = card?.box;
    if (!box || !Number.isFinite(box.top)) continue;
    const end = box.top + box.height;
    const endOrInf = Number.isFinite(end) ? end : Infinity;
    const gap =
      position < box.top ? box.top - position : position < endOrInf ? 0 : position - endOrInf;
    if (gap < best) best = gap;
    if (best === 0) break;
  }
  return best;
}

/**
 * The level whose cards fit the summary cursor better than the selected one.
 * Runs every scroll frame, so it avoids allocating: the selected level is
 * checked first and the other levels are only scanned when it misses.
 *
 * @param {object} input
 * @param {Map<number, Array<{box: {top: number, height: number}}>>} input.levelCards
 * @param {number} input.selectedLevel
 * @param {number} input.relativeY Cursor position in card-box space.
 * @param {number} [input.tolerance]
 * @returns {number|null}
 */
export function suggestLevelForCursor({
  levelCards,
  selectedLevel,
  relativeY,
  tolerance = SUMMARY_LEVEL_HINT_TOLERANCE_PX,
}) {
  if (!(levelCards instanceof Map) || !levelCards.has(selectedLevel)) return null;
  const selectedGap = gapToBoxes(levelCards.get(selectedLevel), relativeY);
  if (!(selectedGap > tolerance)) return null;

  let bestLevel = null;
  let bestCovered = false;
  let bestGap = Infinity;
  let bestDistance = Infinity;
  for (const [level, cards] of levelCards) {
    if (level === selectedLevel) continue;
    const gap = gapToBoxes(cards, relativeY);
    if (!Number.isFinite(gap)) continue;
    const covered = gap <= tolerance;
    // An uncovered candidate must beat the selected level by a wide margin; a
    // selected level with no boxes (infinite gap) accepts only a covering level.
    if (!covered && !(Number.isFinite(selectedGap) && gap < selectedGap / 2)) continue;
    const distance = Math.abs(level - selectedLevel);
    const rankGap = covered ? 0 : gap;
    let better = bestLevel === null;
    if (!better) {
      if (covered !== bestCovered) better = covered;
      else if (rankGap !== bestGap) better = rankGap < bestGap;
      else if (distance !== bestDistance) better = distance < bestDistance;
      else better = level < bestLevel;
    }
    if (better) {
      bestLevel = level;
      bestCovered = covered;
      bestGap = rankGap;
      bestDistance = distance;
    }
  }
  return bestLevel;
}
