const SUMMARY_CURSOR_VIEWPORT_RATIO = 0.38;
const SUMMARY_CURSOR_MIN_TOP = 112;

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
    return { cursorTop: SUMMARY_CURSOR_MIN_TOP, activeCardId: null };
  }

  const cursorTop = Math.max(
    SUMMARY_CURSOR_MIN_TOP,
    Math.round(containerTop + containerHeight * SUMMARY_CURSOR_VIEWPORT_RATIO),
  );
  const relativeY = isWindowScroll ? cursorTop - bodyTop : scrollTop + cursorTop - bodyTop;
  const matching = currentCards
    .filter((card) => relativeY >= card.box.top && relativeY <= card.box.top + card.box.height)
    .sort((a, b) => a.box.height - b.box.height || a.box.top - b.box.top);

  return { cursorTop, activeCardId: matching[0]?.id || null };
}
