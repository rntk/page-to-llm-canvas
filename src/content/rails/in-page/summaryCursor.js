export const SUMMARY_CURSOR_VIEWPORT_RATIO = 0.38;
export const SUMMARY_CURSOR_MIN_TOP = 112;

export function computeSummaryCursorState({
  cards,
  bodyTop,
  containerTop,
  containerHeight,
  scrollTop = 0,
  isWindowScroll = true,
}) {
  const currentCards = Array.isArray(cards) ? cards : [];
  if (currentCards.length === 0) {
    return { cursorTop: SUMMARY_CURSOR_MIN_TOP, activeCardId: null, relativeY: 0 };
  }

  const cursorTop = Math.max(
    SUMMARY_CURSOR_MIN_TOP,
    Math.round(containerTop + containerHeight * SUMMARY_CURSOR_VIEWPORT_RATIO),
  );
  const relativeY = isWindowScroll ? cursorTop - bodyTop : scrollTop + cursorTop - bodyTop;

  // `relativeY` is the cursor's position in card-box space; callers use it to
  // order cards around the cursor even when it falls in a gap between boxes.
  // Scan once for the smallest (height, top) match instead of sorting the
  // whole matching set, since only the first item is ever needed.
  let best = null;
  for (const card of currentCards) {
    const { top, height } = card.box;
    if (relativeY < top || relativeY > top + height) continue;
    if (
      best === null ||
      height < best.box.height ||
      (height === best.box.height && top < best.box.top)
    ) {
      best = card;
    }
  }

  return { cursorTop, activeCardId: best?.id || null, relativeY };
}
