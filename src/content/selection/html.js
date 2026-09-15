import { stripHighlightClasses } from './cssPath.js';
import {
  NEVER_RENDERED_TAGS,
  isRenderedTextNode,
  isBlockBoundary,
  renderedSubtreeIsHidden,
} from '../../shared/dom/renderedText.js';

const CAPTURE_VERSION = 2;

function normalizeRoots(elements) {
  const unique = [];
  for (const element of elements || []) {
    if (!element || unique.includes(element)) continue;
    unique.push(element);
  }
  return unique.filter(
    (element) => !unique.some((candidate) => candidate !== element && candidate.contains(element)),
  );
}

function isTextRendered(node, contentWindow) {
  return isRenderedTextNode(node, undefined, contentWindow);
}

function isSubtreeSuppressed(element, contentWindow) {
  return renderedSubtreeIsHidden(element, undefined, contentWindow);
}

function appendBoundary(parts) {
  if (parts.length > 0 && parts[parts.length - 1] !== '\n') parts.push('\n');
}

function collectRenderedText(node, root, contentWindow, parts) {
  if (node.nodeType === 3) {
    if (isTextRendered(node, contentWindow)) parts.push(node.nodeValue);
    return;
  }
  if (node.nodeType !== 1 || NEVER_RENDERED_TAGS.has(node.tagName)) return;
  if (node.tagName === 'BR') {
    appendBoundary(parts);
    return;
  }
  const boundary = node !== root && isBlockBoundary(node, undefined, contentWindow);
  if (boundary) appendBoundary(parts);
  for (const child of node.childNodes) collectRenderedText(child, root, contentWindow, parts);
  if (boundary) appendBoundary(parts);
}

function cloneRenderedSubtree(original, contentWindow) {
  if (original.nodeType === 3) {
    return isTextRendered(original, contentWindow) ? original.cloneNode(false) : null;
  }
  if (original.nodeType !== 1 || NEVER_RENDERED_TAGS.has(original.tagName)) return null;
  if (isSubtreeSuppressed(original, contentWindow)) return null;

  const clone = original.cloneNode(false);
  for (const child of original.childNodes) {
    const childClone = cloneRenderedSubtree(child, contentWindow);
    if (childClone) clone.appendChild(childClone);
  }
  return clone;
}

/**
 * Capture analysis text while the source document's CSSOM is available, and
 * build an HTML snapshot with definitely non-rendered text removed.
 * @param {Element[]} elements Picked live DOM elements.
 * @param {Window} [contentWindow]
 */
export function buildCapture(
  elements,
  contentWindow = elements?.[0]?.ownerDocument?.defaultView ?? globalThis.window,
) {
  const roots = normalizeRoots(elements);
  const htmlParts = [];
  const textParts = [];
  const capturedRoots = [];
  for (const root of roots) {
    const clone = cloneRenderedSubtree(root, contentWindow);
    if (!clone) continue;
    stripHighlightClasses(clone);
    htmlParts.push(clone.outerHTML);
    capturedRoots.push(root);
    const rootText = [];
    collectRenderedText(root, root, contentWindow, rootText);
    // Boundary newlines are structural separators, so do not leak the one
    // emitted after the final block in a root into the canonical text.
    textParts.push(rootText.join('').replace(/^\n+|\n+$/g, ''));
  }
  return {
    captureVersion: CAPTURE_VERSION,
    html: htmlParts.join('\n'),
    capturedText: textParts.join('\n'),
    elements: capturedRoots,
  };
}
