export const SUMMARY_CURSOR_VIEWPORT_RATIO = 0.38;
export const SUMMARY_CURSOR_MIN_TOP = 112;

/**
 * Where the summary cursor sits and which card it is on.
 *
 * @param {object} opts
 * @param {Array<{id: string, box: {top: number, height: number}}>} opts.cards Cards in document order.
 * @param {number} opts.bodyTop Viewport top of the rail body (the card-box origin).
 * @param {number} opts.containerTop Viewport top of the scroll container.
 * @param {number} opts.containerHeight Visible height of the scroll container.
 * @param {number} [opts.scrollTop] Scroll offset the card track is translated by.
 * @param {number} [opts.remainingScroll] Scrolling left before the scroller hits
 *   its end; Infinity when there is no measurable scroll range.
 * @returns {{cursorTop: number, activeCardId: string|null, relativeY: number}}
 */
export function computeSummaryCursorState({
  cards,
  bodyTop,
  containerTop,
  containerHeight,
  scrollTop = 0,
  remainingScroll = Infinity,
}) {
  const currentCards = Array.isArray(cards) ? cards : [];
  if (currentCards.length === 0) {
    return { cursorTop: SUMMARY_CURSOR_MIN_TOP, activeCardId: null, relativeY: 0 };
  }

  const restingTop = Math.max(
    SUMMARY_CURSOR_MIN_TOP,
    Math.round(containerTop + containerHeight * SUMMARY_CURSOR_VIEWPORT_RATIO),
  );
  // Content in the last viewport-full cannot scroll up to a fixed cursor line:
  // at maximum scroll everything below the line has no way left to reach it, so
  // the closing summaries would never become active. Over that final stretch
  // the cursor glides down to the bottom of the viewport instead, meeting the
  // content the scroller can no longer bring up to it. (The old rail bought the
  // same reachability by making the page itself taller — it was an absolutely
  // positioned, article-height element — which a viewport-height rail cannot
  // and should not do.)
  const containerBottom = containerTop + containerHeight;
  const cursorTop = Math.round(
    Math.max(restingTop, Math.min(containerBottom, containerBottom - remainingScroll)),
  );
  // The body is pinned to the viewport, so the cursor is mapped into card-box
  // space by the same scroll offset the card track is translated by.
  const relativeY = scrollTop + cursorTop - bodyTop;

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
