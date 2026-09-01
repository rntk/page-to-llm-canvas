// Shared browser-side rules for deciding which DOM text participates in the
// rendered-text pipeline. The selection capture and live highlighter must use
// the same tag, layout, and style interpretation or their word indexes drift.

// These elements either never expose fallback text in a normal rendered
// document or are removed wholesale by canvas HTML sanitization.
export const NEVER_RENDERED_TAGS = new Set([
  'CANVAS',
  'EMBED',
  'IFRAME',
  'NOSCRIPT',
  'OBJECT',
  'SCRIPT',
  'STYLE',
  'TEMPLATE',
]);

export const CLOSED_BY_DEFAULT_TAGS = new Set(['DIALOG']);

// Keep this list in step with the capture-side text walker. A boundary is
// inserted around these elements, while inline elements remain one logical
// text stream.
const BLOCK_TAGS = new Set([
  'ADDRESS',
  'ARTICLE',
  'ASIDE',
  'BLOCKQUOTE',
  'DIV',
  'DL',
  'FIELDSET',
  'FIGCAPTION',
  'FIGURE',
  'FOOTER',
  'FORM',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HEADER',
  'HR',
  'LI',
  'MAIN',
  'NAV',
  'OL',
  'P',
  'PRE',
  'SECTION',
  'TABLE',
  'TD',
  'TH',
  'TR',
  'UL',
]);

const BLOCK_DISPLAYS = new Set([
  'block',
  'list-item',
  'table',
  'table-row',
  'table-cell',
  'table-caption',
  'flex',
  'grid',
  'flow-root',
]);

/**
 * Read computed style without making DOM helpers fail in test DOMs or on a
 * detached node. The optional cache is scoped to one DOM walk.
 *
 * @param {Node} node Element whose resolved style is needed.
 * @param {Map<Element, ?CSSStyleDeclaration>} [cache] Per-walk memo.
 * @param {Window} [contentWindow] Window to use when capturing another DOM.
 * @returns {?CSSStyleDeclaration}
 */
export function getComputedStyleSafe(node, cache, contentWindow) {
  if (!node || node.nodeType !== 1) return null;
  if (cache?.has(node)) return cache.get(node);
  const view = contentWindow || node.ownerDocument?.defaultView;
  const getter =
    view && typeof view.getComputedStyle === 'function'
      ? view.getComputedStyle.bind(view)
      : typeof globalThis.getComputedStyle === 'function'
        ? globalThis.getComputedStyle
        : null;
  let computed = null;
  if (getter) {
    try {
      computed = getter(node);
    } catch (_) {
      computed = null;
    }
  }
  cache?.set(node, computed);
  return computed;
}

/**
 * Read a property from a computed CSS declaration.
 * @param {?CSSStyleDeclaration} style Computed style.
 * @param {string} property CSS property name.
 * @param {string} [camelProperty] CSSStyleDeclaration property name.
 * @returns {string}
 */
export function computedProperty(style, property, camelProperty = property) {
  if (!style) return '';
  const value = style[camelProperty];
  if (value != null && value !== '') return String(value).trim().toLowerCase();
  if (typeof style.getPropertyValue === 'function') {
    return String(style.getPropertyValue(property) || '')
      .trim()
      .toLowerCase();
  }
  return '';
}

/**
 * Read a property from an element's inline style.
 * @param {Element} node Element with an inline style.
 * @param {string} property CSS property name.
 * @param {string} [camelProperty] CSSStyleDeclaration property name.
 * @returns {string}
 */
export function inlineProperty(node, property, camelProperty = property) {
  if (!node?.style) return '';
  const value = node.style[camelProperty] || node.style.getPropertyValue?.(property) || '';
  return String(value)
    .replace(/!\s*important\s*$/i, '')
    .trim()
    .toLowerCase();
}

/**
 * Read a style property, falling back to the inline declaration when a DOM
 * shim does not expose the computed value.
 * @param {Element} node Element whose style is being read.
 * @param {?CSSStyleDeclaration} style Computed style.
 * @param {string} property CSS property name.
 * @param {string} [camelProperty] CSSStyleDeclaration property name.
 * @returns {string}
 */
export function propertyValue(node, style, property, camelProperty = property) {
  return (
    computedProperty(style, property, camelProperty) ||
    inlineProperty(node, property, camelProperty)
  );
}

/**
 * Parse opacity from a computed style declaration.
 * @param {?CSSStyleDeclaration} style Computed style.
 * @returns {?number}
 */
export function computedOpacity(style) {
  const value = computedProperty(style, 'opacity', 'opacity');
  if (!value) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Whether computed style suppresses an entire subtree.
 * @param {?CSSStyleDeclaration} style Computed style.
 * @returns {boolean}
 */
export function computedSubtreeIsHidden(style) {
  const opacity = computedOpacity(style);
  return (
    computedProperty(style, 'display', 'display') === 'none' ||
    computedProperty(style, 'content-visibility', 'contentVisibility') === 'hidden' ||
    (opacity != null && opacity <= 0)
  );
}

/**
 * Whether a computed declaration exposes enough layout data to be
 * authoritative over inline-style fallback parsing.
 * @param {?CSSStyleDeclaration} style Computed style.
 * @returns {boolean}
 */
export function computedStyleHasLayoutValues(style) {
  return Boolean(
    computedProperty(style, 'display', 'display') ||
    computedProperty(style, 'content-visibility', 'contentVisibility') ||
    computedOpacity(style) != null,
  );
}

/**
 * Whether an element creates a block-level text boundary.
 * @param {Element} node Element to inspect.
 * @param {Map<Element, ?CSSStyleDeclaration>} [computedStyleCache] Per-walk
 *   computed-style memo.
 * @param {Window} [contentWindow] Window to use when capturing another DOM.
 * @returns {boolean}
 */
export function isBlockBoundary(node, computedStyleCache, contentWindow) {
  const style = getComputedStyleSafe(node, computedStyleCache, contentWindow);
  const display = propertyValue(node, style, 'display', 'display');
  return display ? BLOCK_DISPLAYS.has(display) : BLOCK_TAGS.has(node.tagName);
}
