import { SELECTION_MARKER_CLASSES, SELECTION_MARKER_SELECTOR } from './markers.js';

export function buildCssPath(el) {
  if (!(el instanceof Element)) return '';
  // Resolve against the element's own document, not the global one: the
  // selection controller supports an injected contentDocument, and a
  // connected element from that document must not be mistaken for detached.
  const doc = el.ownerDocument;
  if (!doc) return '';
  // An element inside a shadow root (or otherwise detached from its document)
  // cannot be addressed by a document-level selector at all: the walk below
  // would stop at a null parentElement and emit a path rooted inside the
  // shadow tree, which then matches an unrelated light-DOM element.  Refuse
  // rather than hand back a misleading path.
  if (el.getRootNode && el.getRootNode() !== doc) return '';

  // The id branch trusts that ids are unique, which pages routinely violate.
  // Verify the path resolves back to the element and fall back to a purely
  // structural path when it does not.
  const withId = walkCssPath(el, doc, true);
  if (withId && resolvesTo(doc, withId, el)) return withId;

  const structural = walkCssPath(el, doc, false);
  return structural && resolvesTo(doc, structural, el) ? structural : '';
}

/**
 * Whether `selector` selects exactly `el` within `doc`.  A selector the CSS
 * parser rejects — a namespaced type name such as `svg:rect`, say — counts as
 * a non-match rather than throwing, so an unusable path never aborts a capture.
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
