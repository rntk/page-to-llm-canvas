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

function isTextRendered(node, contentWindow, computedStyleCache) {
  return isRenderedTextNode(node, computedStyleCache, contentWindow);
}

function isSubtreeSuppressed(element, contentWindow, computedStyleCache) {
  return renderedSubtreeIsHidden(element, computedStyleCache, contentWindow);
}

function appendBoundary(parts) {
  if (parts.length > 0 && parts[parts.length - 1] !== '\n') parts.push('\n');
}

// Unlike getRenderedText, hidden non-root blocks are not pruned: they still emit
// boundaries, matching the highlighter's word segmentation in sentenceHighlight.js.
function collectRenderedText(node, root, contentWindow, parts, computedStyleCache) {
  if (node.nodeType === 3) {
    if (isTextRendered(node, contentWindow, computedStyleCache)) parts.push(node.nodeValue);
    return;
  }
  if (node.nodeType !== 1 || NEVER_RENDERED_TAGS.has(node.tagName)) return;
  if (node.tagName === 'BR') {
    appendBoundary(parts);
    return;
  }
  const boundary = node !== root && isBlockBoundary(node, computedStyleCache, contentWindow);
  if (boundary) appendBoundary(parts);
  for (const child of node.childNodes) {
    collectRenderedText(child, root, contentWindow, parts, computedStyleCache);
  }
  if (boundary) appendBoundary(parts);
}

/**
 * Read UI snippets with the capture text rules, stopping at `maxLength`.
 * @param {Node} root Subtree to read.
 * @param {Window} [contentWindow] Window containing the subtree.
 * @param {number} [maxLength] Collapsed characters to collect before stopping.
 * @param {Map<Element, ?CSSStyleDeclaration>} [computedStyleCache] Per-call
 *   computed-style memo so one block resolves each ancestor once.
 * @returns {string} Rendered text with `\n` block separators, trimmed.
 */
export function getRenderedText(
  root,
  contentWindow,
  maxLength = Infinity,
  computedStyleCache = new Map(),
) {
  if (!root) return '';
  const window = contentWindow ?? root.ownerDocument?.defaultView ?? globalThis.window;
  const cache = computedStyleCache ?? new Map();
  if (root.nodeType === 3) return root.nodeValue || '';
  if (root.nodeType !== 1) {
    if (typeof root.childNodes?.[Symbol.iterator] !== 'function') return '';
    const parts = [];
    let length = 0;
    let endsWithSpace = true;
    for (const child of root.childNodes) {
      const part = getRenderedText(child, window, maxLength - length, cache);
      parts.push(part);
      const collapsed = part.replace(/\s+/g, ' ');
      const addition = endsWithSpace ? collapsed.replace(/^ /, '') : collapsed;
      if (addition) {
        length += addition.length;
        endsWithSpace = addition.endsWith(' ');
      }
      if (length >= maxLength) break;
    }
    return parts.join('').replace(/^\n+|\n+$/g, '');
  }
  if (NEVER_RENDERED_TAGS.has(root.tagName)) return '';
  if (isSubtreeSuppressed(root, window, cache)) return '';

  const parts = [];
  let collapsedLength = 0;
  // Ignore leading whitespace and collapsed boundaries in the snippet budget.
  let endsWithSpace = true;
  let truncated = false;

  // Count only the text surviving whitespace collapse.
  function accountCollapsed(value) {
    const collapsed = value.replace(/\s+/g, ' ');
    const addition = endsWithSpace ? collapsed.replace(/^ /, '') : collapsed;
    if (!addition) return;
    collapsedLength += addition.length;
    endsWithSpace = addition.endsWith(' ');
    if (collapsedLength >= maxLength) truncated = true;
  }

  function walk(node, isRoot) {
    if (truncated) return;
    if (node.nodeType === 3) {
      if (!isTextRendered(node, window, cache)) return;
      const value = node.nodeValue || '';
      if (!value) return;
      parts.push(value);
      accountCollapsed(value);
      return;
    }
    if (node.nodeType !== 1) return;
    if (node.tagName === 'BR') {
      appendBoundary(parts);
      accountCollapsed('\n');
      return;
    }
    if (NEVER_RENDERED_TAGS.has(node.tagName)) return;
    if (!isRoot && isSubtreeSuppressed(node, window, cache)) return;
    const boundary = !isRoot && isBlockBoundary(node, cache, window);
    if (boundary) {
      appendBoundary(parts);
      accountCollapsed('\n');
    }
    for (const child of node.childNodes) {
      walk(child, false);
      if (truncated) break;
    }
    if (boundary && !truncated) {
      appendBoundary(parts);
      accountCollapsed('\n');
    }
  }

  walk(root, true);
  return parts.join('').replace(/^\n+|\n+$/g, '');
}

function cloneRenderedSubtree(original, contentWindow, computedStyleCache) {
  if (original.nodeType === 3) {
    return isTextRendered(original, contentWindow, computedStyleCache)
      ? original.cloneNode(false)
      : null;
  }
  if (original.nodeType !== 1 || NEVER_RENDERED_TAGS.has(original.tagName)) return null;
  if (isSubtreeSuppressed(original, contentWindow, computedStyleCache)) return null;

  const clone = original.cloneNode(false);
  for (const child of original.childNodes) {
    const childClone = cloneRenderedSubtree(child, contentWindow, computedStyleCache);
    if (childClone) clone.appendChild(childClone);
  }
  return clone;
}

/**
 * Capture analysis text while the source document's CSSOM is available, and
 * build an HTML snapshot with non-rendered text removed.
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
  // One memo for both walks over every root; the live DOM is not mutated here.
  const styleCache = new Map();
  for (const root of roots) {
    const clone = cloneRenderedSubtree(root, contentWindow, styleCache);
    if (!clone) continue;
    stripHighlightClasses(clone);
    htmlParts.push(clone.outerHTML);
    capturedRoots.push(root);
    const rootText = [];
    collectRenderedText(root, root, contentWindow, rootText, styleCache);
    // Drop the trailing structural newline from each root.
    textParts.push(rootText.join('').replace(/^\n+|\n+$/g, ''));
  }
  return {
    captureVersion: CAPTURE_VERSION,
    html: htmlParts.join('\n'),
    capturedText: textParts.join('\n'),
    elements: capturedRoots,
  };
}
