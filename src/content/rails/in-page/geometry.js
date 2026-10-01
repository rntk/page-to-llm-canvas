import { buildSentenceDomRange } from '../../../highlights/sentenceHighlight.js';

/**
 * Geometry and scroll helpers for the in-page rail.
 */

export function getScrollTop(scrollContainer, win = window) {
  return scrollContainer && scrollContainer !== win ? scrollContainer.scrollTop : win.scrollY;
}

/**
 * Origin the card boxes are measured from: the rail body's viewport top.
 *
 * The body stays fixed while the card track follows window or inner scrolling.
 *
 * @param {{top: number}} bodyRect Rail body rect, measured untransformed.
 * @returns {number} Viewport offset the card boxes are relative to.
 */
export function getRailOriginTop(bodyRect) {
  return bodyRect.top;
}

export function getScrollableAncestor(
  elements,
  {
    win = window,
    // Preserve the Window receiver required by getComputedStyle.
    getComputedStyle = (el) => win.getComputedStyle(el),
    body = win.document.body,
    docEl = win.document.documentElement,
  } = {},
) {
  const picked = Array.isArray(elements) ? elements.filter(Boolean) : [];
  if (picked.length === 0) return win;

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

  return win;
}

export function computeCardVerticalBox(
  sentences,
  sentenceRanges,
  wordEntries,
  railOriginTop,
  scrollContainer,
  { buildRange = buildSentenceDomRange, win = window } = {},
) {
  if (!sentences || sentences.length === 0) return null;
  let top = Infinity,
    bottom = -Infinity,
    right = -Infinity;
  const isLaidOut = (rect) => rect && (rect.width > 0 || rect.height > 0);
  const scrollTop = getScrollTop(scrollContainer, win);
  for (const sNum of sentences) {
    const domRange = buildRange(sentenceRanges, wordEntries, sNum);
    if (!domRange) continue;
    // Measure each line box; skip unlaid-out rects that would collapse top to 0.
    const rects = Array.from(domRange.getClientRects()).filter(isLaidOut);
    if (rects.length === 0) continue;
    const sTop = Math.min(...rects.map((r) => r.top)) + scrollTop - railOriginTop;
    const sBottom = Math.max(...rects.map((r) => r.bottom)) + scrollTop - railOriginTop;
    if (sTop < top) top = sTop;
    if (sBottom > bottom) bottom = sBottom;
    const sRight = Math.max(...rects.map((r) => r.right));
    if (sRight > right) right = sRight;
  }
  if (!Number.isFinite(top) || !Number.isFinite(bottom)) return null;
  const clampedTop = Math.max(0, top);
  // `right` is the text edge in viewport x (horizontal scroll is not tracked):
  // topic notes are drawn just past it, beside the sentences they annotate.
  return { top: clampedTop, height: Math.max(40, bottom - clampedTop), right };
}
