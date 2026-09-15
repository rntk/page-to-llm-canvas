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

/**
 * Text-only counterpart to {@link collectRenderedText} for UI snippets.
 * Reuses the same rendered-text predicates so toolbar labels cannot drift
 * from the submitted capture text. Stops descending once `maxLength`
 * characters have been collected, so large articles are not walked fully
 * for a 30/120-char label.
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
  // The joined output is collapsed and trimmed by callers, so leading
  // whitespace contributes nothing and adjacent whitespace runs merge into
  // one. Treat the start as trailing a space so leading whitespace and
  // no-op boundaries cost nothing instead of each consuming budget.
  let endsWithSpace = true;
  let truncated = false;

  // Account for an emitted raw string by the length it contributes to the
  // final collapsed output, merging whitespace runs with the output so far
  // instead of counting every node and boundary attempt separately.
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
