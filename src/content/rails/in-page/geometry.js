import { buildSentenceDomRange } from '../../../highlights/sentenceHighlight.js';

/** Geometry and scroll helpers for the in-page rail. */

export function getScrollTop(scrollContainer, win = window) {
  return scrollContainer && scrollContainer !== win ? scrollContainer.scrollTop : win.scrollY;
}

/**
 * Origin the card boxes are measured from: the rail body's viewport top.
 * The body stays fixed while the card track follows window or inner scrolling.
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
    right = -Infinity,
    left = Infinity;
  const isLaidOut = (rect) => rect && (rect.width > 0 || rect.height > 0);
  const scrollTop = getScrollTop(scrollContainer, win);
  for (const sNum of sentences) {
    const domRange = buildRange(sentenceRanges, wordEntries, sNum);
    if (!domRange) continue;
    // Measure each line box; skip unlaid-out rects that would collapse top to 0.
    for (const rect of domRange.getClientRects()) {
      if (!isLaidOut(rect)) continue;
      if (rect.top < top) top = rect.top;
      if (rect.bottom > bottom) bottom = rect.bottom;
      if (rect.right > right) right = rect.right;
      if (rect.left < left) left = rect.left;
    }
  }
  const verticalOffset = scrollTop - railOriginTop;
  top += verticalOffset;
  bottom += verticalOffset;
  if (!Number.isFinite(top) || !Number.isFinite(bottom)) return null;
  const clampedTop = Math.max(0, top);
  // `right`/`left`: text edges in viewport x (horizontal scroll untracked); topic notes sit
  // just past the edge on the rail's side.
  return { top: clampedTop, height: Math.max(40, bottom - clampedTop), right, left };
}
