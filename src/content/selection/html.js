import { stripHighlightClasses } from './cssPath.js';

/**
 * Build the submission HTML for a list of picked elements.
 * Clones each, strips highlight UI classes, and joins with newlines.
 * Pure-ish transformation suitable for unit testing with DOM.
 * @param {Element[]} elements Picked DOM elements.
 */
export function buildHtml(elements) {
  const parts = [];
  for (const el of elements) {
    const clone = el.cloneNode(true);
    stripHighlightClasses(clone);
    parts.push(clone.outerHTML);
  }
  return parts.join('\n');
}
