import { buildSentenceDomRange } from '../../../highlights/sentenceHighlight.js';
import { SUMMARY_CURSOR_MIN_TOP, SUMMARY_CURSOR_VIEWPORT_RATIO } from './summaryCursor.js';

/**
 * Geometry and scroll helpers extracted from the in-page rail logic
 * (src/content/rails/in-page/controller.jsx) so they can be unit tested in isolation.
 *
 * Defaults preserve original behavior using global window/document.
 */

export function getScrollTop(scrollContainer, win = window) {
  return scrollContainer && scrollContainer !== win ? scrollContainer.scrollTop : win.scrollY;
}

export function getRailOriginTop(bodyRect, scrollContainer, win = window) {
  return scrollContainer && scrollContainer !== win ? bodyRect.top : bodyRect.top + win.scrollY;
}

export function getScrollableAncestor(
  elements,
  {
    // Wrap to preserve the Window receiver. Bare `window.getComputedStyle` as a default
    // would be invoked detached in strict mode (ES modules), and Chrome brand-checks
    // WebIDL operations like getComputedStyle (same as requestAnimationFrame etc.).
    getComputedStyle = (el) => window.getComputedStyle(el),
    body = document.body,
    docEl = document.documentElement,
  } = {},
) {
  const picked = Array.isArray(elements) ? elements.filter(Boolean) : [];
  if (picked.length === 0) return window;

  const containsPickedElements = (candidate) =>
    picked.every((el) => candidate === el || candidate.contains(el));
  const isScrollable = (el) => {
    if (!el || el === body || el === docEl) return false;
    const style = getComputedStyle(el);
    const overflowY = `${style.overflowY} ${style.overflow}`;
    return /(auto|scroll|overlay)/.test(overflowY) && el.scrollHeight > el.clientHeight + 1;
  };

  let node = picked[0];
  while (node && node !== body && node !== docEl) {
    if (isScrollable(node) && containsPickedElements(node)) return node;
    node = node.parentElement;
  }

  return window;
}

/** Slack kept below the last card so the rail doesn't end flush with it. */
export const RAIL_TRAILING_PAD = 80;

/**
 * Trailing space to add below the last card box when sizing the rail body.
 *
 * In summaries mode the visible column (`.pagetollm-summary-stack`) is fixed to
 * the viewport: it hangs from the cursor line down to the viewport bottom. When
 * the cursor sits on the last card, everything below the cursor line is still
 * painted, so a rail that stops `RAIL_TRAILING_PAD` under the last card leaves
 * that part of the column without any rail background behind it — the summary
 * appears to float. Reserve the distance from the cursor line to the bottom of
 * the scroll viewport instead, mirroring computeSummaryCursorState()'s cursor
 * placement so both agree in nested scrollers too.
 *
 * @param {object} opts
 * @param {boolean} opts.isSummary Whether the rail is in summaries mode.
 * @param {Window|Element|null} opts.scrollContainer Scroller the rail follows.
 * @param {Window} [opts.win] Window override for tests.
 * @returns {number} Pixels to add below the lowest card box.
 */
export function computeRailTrailingPad({ isSummary, scrollContainer, win = window }) {
  if (!isSummary) return RAIL_TRAILING_PAD;
  const isWindowScroll = !scrollContainer || scrollContainer === win;
  const containerTop = isWindowScroll ? 0 : scrollContainer.getBoundingClientRect().top;
  const containerHeight = isWindowScroll
    ? win.innerHeight
    : scrollContainer.clientHeight || win.innerHeight;
  const cursorTop = Math.max(
    SUMMARY_CURSOR_MIN_TOP,
    Math.round(containerTop + containerHeight * SUMMARY_CURSOR_VIEWPORT_RATIO),
  );
  return Math.max(RAIL_TRAILING_PAD, Math.round(containerTop + containerHeight - cursorTop));
}

export function computeCardVerticalBox(
  sentences,
  sentenceRanges,
  wordEntries,
  railOriginTop,
  scrollContainer,
  { buildRange = buildSentenceDomRange } = {},
) {
  if (!sentences || sentences.length === 0) return null;
  let top = Infinity,
    bottom = -Infinity;
  const isLaidOut = (rect) => rect && (rect.width > 0 || rect.height > 0);
  const scrollTop = getScrollTop(scrollContainer);
  for (const sNum of sentences) {
    const domRange = buildRange(sentenceRanges, wordEntries, sNum);
    if (!domRange) continue;
    // getClientRects() yields one rect per line box the sentence spans, giving
    // a tighter measurement than the start/end corners alone. Skip rects that
    // aren't laid out (display:none etc.) so they don't collapse `top` to 0.
    const rects = Array.from(domRange.getClientRects()).filter(isLaidOut);
    if (rects.length === 0) continue;
    const sTop = Math.min(...rects.map((r) => r.top)) + scrollTop - railOriginTop;
    const sBottom = Math.max(...rects.map((r) => r.bottom)) + scrollTop - railOriginTop;
    if (sTop < top) top = sTop;
    if (sBottom > bottom) bottom = sBottom;
  }
  if (!Number.isFinite(top) || !Number.isFinite(bottom)) return null;
  const clampedTop = Math.max(0, top);
  return { top: clampedTop, height: Math.max(40, bottom - clampedTop) };
}
