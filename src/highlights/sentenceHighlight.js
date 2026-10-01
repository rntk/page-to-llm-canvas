// Match stored sentences to live DOM text for the rail and canvas highlights.
import {
  CLOSED_BY_DEFAULT_TAGS,
  NEVER_RENDERED_TAGS,
  computedOpacity,
  computedProperty,
  computedStyleHasLayoutValues,
  computedSubtreeIsHidden,
  getComputedStyleSafe,
  inlineProperty,
  isBlockBoundary,
} from '../shared/dom/renderedText.js';

// Stateful (`g`): reset `lastIndex` before every `exec` scan.
const WORD_TOKEN_RE = /\S+/g;
// Stateful (`g`), but String#replace resets it before matching.
const NORMALIZE_RE = /[^\p{L}\p{N}]+/gu;
export const HIGHLIGHT_NAME = 'pagetollm-sentence';
/** Shared CSS Custom Highlight name for chat sentences. */
export const CHAT_HIGHLIGHT_NAME = 'pagetollm-chat-sentence';

export function supportsHighlightApi() {
  return typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight !== 'undefined';
}

export function tokenizeText(text) {
  return String(text || '').match(WORD_TOKEN_RE) || [];
}

// Use computed styles when available; parse inline styles in DOM-only environments.
const HIDING_VALUES = new Map([
  ['display', 'none'],
  ['content-visibility', 'hidden'],
]);

const IMPORTANT_SUFFIX_RE = /!\s*important$/;

/**
 * Split an inline `style` attribute into its declarations.
 *
 * A plain `split(';')` misreads quoted values and `url(...)` as declarations.
 * @param {string} style Raw inline style attribute value.
 * @returns {string[]} Declaration texts, `property: value` still unparsed.
 */
function splitDeclarations(style) {
  const segments = [];
  let start = 0;
  let quote = '';
  let parens = 0;
  for (let i = 0; i < style.length; i++) {
    const ch = style[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '/' && style[i + 1] === '*') {
      const commentEnd = style.indexOf('*/', i + 2);
      i = commentEnd < 0 ? style.length : commentEnd + 1;
    } else if (ch === '(') {
      parens += 1;
    } else if (ch === ')') {
      if (parens > 0) parens -= 1;
    } else if (ch === ';' && parens === 0) {
      segments.push(style.slice(start, i));
      start = i + 1;
    }
  }
  segments.push(style.slice(start));
  return segments;
}

/**
 * Whether an inline `style` attribute resolves to a layout-suppressing value.
 *
 * A later declaration wins (`display:none;display:block` renders), except that
 * a normal declaration never overrides an important one.
 * @param {string} style Raw inline style attribute value.
 * @returns {boolean}
 */
function hasHidingDeclaration(style) {
  if (!style || !style.includes(':')) return false;
  const winners = new Map();
  for (const segment of splitDeclarations(style)) {
    const colon = segment.indexOf(':');
    if (colon < 0) continue;
    const property = segment.slice(0, colon).trim().toLowerCase();
    if (!HIDING_VALUES.has(property)) continue;
    let value = segment
      .slice(colon + 1)
      .trim()
      .toLowerCase();
    const important = IMPORTANT_SUFFIX_RE.test(value);
    if (important) value = value.replace(IMPORTANT_SUFFIX_RE, '').trim();
    const previous = winners.get(property);
    if (previous && previous.important && !important) continue;
    winners.set(property, { value, important });
  }
  for (const [property, hidingValue] of HIDING_VALUES) {
    if (winners.get(property)?.value === hidingValue) return true;
  }
  return false;
}

/**
 * Whether a node's whole subtree is invisible to the word walk.
 *
 * Keep the live word walk aligned with capture filtering, or later sentences
 * may map to the wrong DOM words.
 *
 * A closed `<details>` still renders its `<summary>`; the walk excludes only
 * its remaining contents.
 * @param {Node} node Candidate ancestor of a text node.
 * @param {Map<Element, ?CSSStyleDeclaration>} [computedStyleCache] Optional
 *   per-walk computed-style memo.
 * @returns {boolean}
 */
export function isSkippableContainer(node, computedStyleCache) {
  if (!node || node.nodeType !== 1) return false;
  const tag = node.tagName;
  if (NEVER_RENDERED_TAGS.has(tag)) return true;
  if (node.id === 'pagetollm-in-page-rail') return true;
  if (typeof node.hasAttribute !== 'function') return false;
  // Match capture filtering even if author CSS overrides [hidden].
  if (node.hasAttribute('hidden')) return true;
  if (CLOSED_BY_DEFAULT_TAGS.has(tag) && !node.hasAttribute('open')) return true;
  const computed = getComputedStyleSafe(node, computedStyleCache);
  // A computed style includes author overrides; fall back for incomplete DOM shims.
  if (computedStyleHasLayoutValues(computed)) {
    return computedSubtreeIsHidden(computed);
  }
  return hasHidingDeclaration(node.getAttribute('style') || '');
}

/**
 * Find the first direct `<summary>` child rendered by a collapsed `<details>`.
 * Descendant summaries belong to other content.
 * @param {Element} details A `details` element.
 * @param {Map<Element, ?Element>} cache Per-walk memo, since this is asked once
 *   per text node below a collapsed subtree.
 * @returns {?Element}
 */
function getOwnSummary(details, cache) {
  if (cache.has(details)) return cache.get(details);
  let own = null;
  for (const child of details.children) {
    if (child.tagName === 'SUMMARY') {
      own = child;
      break;
    }
  }
  cache.set(details, own);
  return own;
}

/**
 * Whether a collapsed `<details>` hides `node` outside its `<summary>`.
 * @param {Element} ancestor Element on the path from `node` to the walk root.
 * @param {Node} node The text node being filtered.
 * @param {Map<Element, ?Element>} cache Per-walk summary memo.
 * @returns {boolean}
 */
function isCollapsedDetailsContent(ancestor, node, cache) {
  if (ancestor.tagName !== 'DETAILS' || ancestor.hasAttribute('open')) return false;
  const summary = getOwnSummary(ancestor, cache);
  return !summary || !summary.contains(node);
}

/**
 * Record word positions without mutating the DOM. Adjacent inline text nodes
 * share one stream, so `<span>hel</span><span>lo</span>` is one word.
 * Returns entries of the form:
 * [{ word, node, start, endNode, end }], where the start and end anchors may
 * be in different live text nodes.
 * @param {Node[]} roots DOM roots to traverse.
 */
export function collectWordEntries(roots) {
  const entries = [];
  const summaryCache = new Map();
  const computedStyleCache = new Map();
  let currentWord = null;

  const flushWord = () => {
    if (!currentWord) return;
    entries.push(currentWord);
    currentWord = null;
  };

  const appendText = (textNode) => {
    const value = textNode.nodeValue || '';
    for (let index = 0; index < value.length; index += 1) {
      const character = value[index];
      if (/\s/.test(character)) {
        flushWord();
        continue;
      }
      if (!currentWord) {
        currentWord = {
          word: character,
          node: textNode,
          start: index,
          endNode: textNode,
          end: index + 1,
        };
      } else {
        currentWord.word += character;
        currentWord.endNode = textNode;
        currentWord.end = index + 1;
      }
    }
  };

  const isAcceptedTextNode = (node, root) => {
    let p = node.parentNode;
    while (p && p !== root.parentNode) {
      // visit() has already pruned every skippable ancestor. This walk remains
      // necessary for the partial-subtree semantics of collapsed <details>.
      if (isCollapsedDetailsContent(p, node, summaryCache)) return false;
      p = p.parentNode;
    }
    // `visibility` is inherited, so the computed value on the text node's
    // immediate parent includes any hidden ancestor and reflects a visible
    // descendant override. Opacity is multiplicative across ancestors, so
    // inspect the complete path for opacity:0.
    const parent = node.parentNode;
    const parentStyle = getComputedStyleSafe(parent, computedStyleCache);
    const visibility =
      computedProperty(parentStyle, 'visibility', 'visibility') ||
      inlineProperty(parent, 'visibility', 'visibility');
    if (visibility === 'hidden' || visibility === 'collapse') return false;
    let opacity = 1;
    p = parent;
    while (p && p !== root.parentNode) {
      const style = getComputedStyleSafe(p, computedStyleCache);
      const inlineOpacity = Number.parseFloat(inlineProperty(p, 'opacity', 'opacity'));
      const ownOpacity =
        computedOpacity(style) ?? (Number.isFinite(inlineOpacity) ? inlineOpacity : null);
      if (ownOpacity != null) {
        opacity *= ownOpacity;
        if (opacity <= 0) return false;
      }
      p = p.parentNode;
    }
    // Keep whitespace nodes so adjacent words do not merge.
    return Boolean(node.nodeValue);
  };

  const visit = (node, root) => {
    if (node.nodeType === 3) {
      if (isAcceptedTextNode(node, root)) appendText(node);
      return;
    }
    if (node.nodeType !== 1 || NEVER_RENDERED_TAGS.has(node.tagName)) return;
    if (node.tagName === 'BR') {
      flushWord();
      return;
    }
    const boundary = node !== root && isBlockBoundary(node, computedStyleCache);
    if (boundary) flushWord();
    // Suppressed blocks still separate adjacent visible text.
    if (!isSkippableContainer(node, computedStyleCache)) {
      for (const child of node.childNodes) visit(child, root);
    }
    if (boundary) flushWord();
  };

  for (const root of roots || []) {
    if (!root) continue;
    flushWord();
    visit(root, root);
    flushWord();
  }

  return entries;
}

/**
 * Build a live DOM Range spanning from the first word to the last word of a
 * sentence (inclusive). Returns null if the entries are missing.
 * @param {Map<number, object>} sentenceRanges Sentence-to-word ranges.
 * @param {object[]} wordEntries Ordered word entries.
 * @param {number} sNum 1-based sentence number.
 */
export function buildSentenceDomRange(sentenceRanges, wordEntries, sNum) {
  const range = sentenceRanges.get(sNum);
  if (!range) return null;
  const startEntry = wordEntries[range.startIdx];
  const endEntry = wordEntries[range.endIdx];
  if (!startEntry || !endEntry) return null;
  try {
    // Use the node's document for embedded content.
    const ownerDocument = startEntry.node?.ownerDocument;
    if (!ownerDocument?.createRange) return null;
    const domRange = ownerDocument.createRange();
    domRange.setStart(startEntry.node, startEntry.start);
    domRange.setEnd(endEntry.endNode || endEntry.node, endEntry.end);
    return domRange;
  } catch (_) {
    return null;
  }
}

/**
 * Register a named highlight for resolved sentences, or clear it when empty.
 * Callers must first check `supportsHighlightApi()`.
 *
 * @param {string} name
 * @param {Iterable<number> | null | undefined} sentenceNumbers
 * @param {{ wordEntries: Array<unknown>, sentenceRanges: Map<number, unknown> }} params
 * @returns {void}
 */
export function paintSentenceHighlight(name, sentenceNumbers, { wordEntries, sentenceRanges }) {
  const nums = sentenceNumbers ? Array.from(sentenceNumbers) : [];
  if (!nums.length) {
    CSS.highlights.delete(name);
    return;
  }
  const highlight = new Highlight();
  let any = false;
  for (const n of nums) {
    const domRange = buildSentenceDomRange(sentenceRanges, wordEntries, n);
    if (domRange) {
      highlight.add(domRange);
      any = true;
    }
  }
  if (any) CSS.highlights.set(name, highlight);
  else CSS.highlights.delete(name);
}

/**
 * Map each sentence (1-based) to a [wordStartIndex, wordEndIndex] (inclusive).
 *
 * Anchor both ends to DOM words despite tokenization drift. A distant start
 * requires a two-token match to avoid advancing past later sentences.
 * @param {string[]} sentences Article sentences.
 * @param {object[]} wordEntries Ordered DOM word entries.
 */
export function buildSentenceWordRanges(sentences, wordEntries) {
  const ranges = new Map();
  const normalize = (s) => String(s).toLowerCase().replace(NORMALIZE_RE, '');
  const norm = wordEntries.map((e) => normalize(e.word));
  const START_WINDOW = 80;
  const END_WINDOW = 12;
  let cursor = 0;

  sentences.forEach((sentText, i) => {
    const tokens = tokenizeText(sentText);
    if (tokens.length === 0) return;
    // Empty normalized tokens cannot anchor a sentence.
    const normalizedTokens = tokens.map(normalize).filter(Boolean);
    if (normalizedTokens.length === 0) return;

    // Search nearby first; larger page mutations require a guarded distant search.
    const targetFirst = normalizedTokens[0];
    let startIdx = -1;
    const nearbyEnd = Math.min(norm.length, cursor + START_WINDOW);
    for (let k = cursor; k < nearbyEnd; k++) {
      if (norm[k] === targetFirst) {
        startIdx = k;
        break;
      }
    }
    // Require two consecutive tokens for a distant start anchor.
    if (startIdx === -1 && normalizedTokens.length >= 2) {
      for (let k = nearbyEnd; k < norm.length; k++) {
        if (norm[k] === targetFirst && norm[k + 1] === normalizedTokens[1]) {
          startIdx = k;
          break;
        }
      }
    }
    // Keep the cursor on failure so later sentences can resynchronize.
    if (startIdx === -1) return;

    // Position the end would land at if tokens mapped 1:1 with DOM words.
    const expectedEnd = Math.min(norm.length - 1, startIdx + normalizedTokens.length - 1);

    let endIdx;
    if (normalizedTokens.length === 1) {
      endIdx = startIdx;
    } else {
      // Find the last token near the expected end despite token drift.
      const targetLast = normalizedTokens[normalizedTokens.length - 1];
      const lo = Math.max(startIdx, expectedEnd - END_WINDOW);
      const hi = Math.min(norm.length - 1, expectedEnd + END_WINDOW);
      let best = -1;
      for (let k = lo; k <= hi; k++) {
        if (
          norm[k] === targetLast &&
          (best === -1 || Math.abs(k - expectedEnd) < Math.abs(best - expectedEnd))
        ) {
          best = k;
        }
      }
      // Do not guess a missing end; keep the cursor available for recovery.
      if (best < startIdx) return;
      endIdx = best;
    }

    ranges.set(i + 1, { startIdx, endIdx });
    cursor = endIdx + 1;
  });

  return ranges;
}
