import { SELECTION_MARKER_CLASSES, SELECTION_MARKER_SELECTOR } from './markers.js';

export function buildCssPath(el) {
  if (!(el instanceof Element)) return '';
  const parts = [];
  let node = el;
  while (node && node.nodeType === 1 && node !== document.documentElement) {
    let selector = node.nodeName.toLowerCase();
    if (node.id) {
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
