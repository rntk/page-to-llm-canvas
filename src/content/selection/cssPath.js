import { SELECTION_MARKER_CLASSES, SELECTION_MARKER_SELECTOR } from './markers.js';

export function buildCssPath(el) {
  if (!(el instanceof Element)) return '';
  // Check the element's own document, including injected documents.
  const doc = el.ownerDocument;
  if (!doc) return '';
  // Document selectors cannot address shadow or detached elements.
  if (el.getRootNode && el.getRootNode() !== doc) return '';

  // Duplicate IDs require a structural selector fallback.
  const withId = walkCssPath(el, doc, true);
  if (withId && resolvesTo(doc, withId, el)) return withId;

  const structural = walkCssPath(el, doc, false);
  return structural && resolvesTo(doc, structural, el) ? structural : '';
}

/**
 * Check that a selector resolves to `el`; invalid selectors count as misses.
 *
 * @param {Document} doc
 * @param {string} selector
 * @param {Element} el
 * @returns {boolean}
 */
function resolvesTo(doc, selector, el) {
  try {
    return doc.querySelector(selector) === el;
  } catch (_) {
    return false;
  }
}

/**
 * Walk from `el` up to the document element building a selector.  When `useId`
 * is true the walk stops early at the first ancestor carrying an id.
 *
 * @param {Element} el
 * @param {Document} doc
 * @param {boolean} useId
 * @returns {string}
 */
function walkCssPath(el, doc, useId) {
  const parts = [];
  let node = el;
  while (node && node.nodeType === 1 && node !== doc.documentElement) {
    let selector = node.nodeName.toLowerCase();
    if (useId && node.id) {
      selector += `#${CSS.escape(node.id)}`;
      parts.unshift(selector);
      break;
    }
    let sib = node,
      nth = 1;
    while ((sib = sib.previousElementSibling)) {
      if (sib.nodeName === node.nodeName) nth++;
    }
    selector += `:nth-of-type(${nth})`;
    parts.unshift(selector);
    node = node.parentElement;
  }
  return parts.join(' > ');
}

export function stripHighlightClasses(clone) {
  if (clone.classList) {
    clone.classList.remove(...SELECTION_MARKER_CLASSES);
  }
  clone.querySelectorAll &&
    clone.querySelectorAll(SELECTION_MARKER_SELECTOR).forEach((c) => {
      c.classList.remove(...SELECTION_MARKER_CLASSES);
    });
}
