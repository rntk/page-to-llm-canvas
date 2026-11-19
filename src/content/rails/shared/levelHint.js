/**
 * Level hints: when the level a rail shows has nothing for the current moment
 * (a gap in the topics, or before/after its first/last card) but another level
 * does, the rail quietly points at that level.
 *
 * The helper is unit-agnostic: callers measure a per-level "gap" in their own
 * unit (seconds for YouTube, pixels of card-box space for the in-page rail).
 */

/**
 * Distance from `position` to the nearest span; 0 when a span covers it.
 *
 * @param {Array<{start: number, end?: number|null}>} spans `end` is exclusive;
 *   a missing or non-finite `end` means open-ended.
 * @param {number} position
 * @returns {number} Infinity when there are no usable spans.
 */
export function gapToSpans(spans, position) {
  if (!Array.isArray(spans) || !Number.isFinite(position)) return Infinity;
  let best = Infinity;
  for (const span of spans) {
    if (!span || !Number.isFinite(span.start)) continue;
    const end = Number.isFinite(span.end) ? span.end : Infinity;
    const gap = position < span.start ? span.start - position : position < end ? 0 : position - end;
    if (gap < best) best = gap;
    if (best === 0) break;
  }
  return best;
}

/**
 * Pick the level to suggest, or null when the selected level fits well enough.
 *
 * A hint needs the selected level to miss the position by more than `tolerance`
 * and another level to miss by at most `tolerance` (a covering level) or, failing
 * that, by clearly less. Ties go to the level nearest the selected one, parent
 * first.
 *
 * @param {object} input
 * @param {number} input.selectedLevel
 * @param {Map<number, number>|Record<number, number>} input.gaps Level → gap.
 * @param {number} [input.tolerance=0] Gap still counted as "covered".
 * @returns {number|null}
 */
export function suggestBetterLevel({ selectedLevel, gaps, tolerance = 0 }) {
  const entries = gaps instanceof Map ? [...gaps] : Object.entries(gaps || {});
  const gapByLevel = new Map(entries.map(([level, gap]) => [Number(level), gap]));
  const selectedGap = gapByLevel.get(selectedLevel);
  if (selectedGap == null || !(selectedGap > tolerance)) return null;

  let best = null;
  for (const [level, gap] of gapByLevel) {
    if (level === selectedLevel || !Number.isFinite(gap)) continue;
    const covered = gap <= tolerance;
    // An uncovered candidate must still beat the selected level by a wide margin.
    // A selected level with no items at all has an infinite gap: only a covering level helps.
    if (!covered && !(Number.isFinite(selectedGap) && gap < selectedGap / 2)) continue;
    const rank = [covered ? 0 : 1, covered ? 0 : gap, Math.abs(level - selectedLevel), level];
    if (!best || compareRank(rank, best.rank) < 0) best = { level, rank };
  }
  return best ? best.level : null;
}

function compareRank(a, b) {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}
