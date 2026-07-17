import { buildSentenceDomRange } from '../../../highlights/sentenceHighlight.js';

/**
 * Geometry and scroll helpers extracted from the in-page rail logic
 * (src/content/main.jsx) so they can be unit tested in isolation.
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
