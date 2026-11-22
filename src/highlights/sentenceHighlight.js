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
 * Must match capture filtering, or later sentences map to the wrong words.
 * A closed `<details>` still renders its `<summary>`, so only its other
 * contents are excluded.
 * @param {Node} node Candidate ancestor of a text node.
 * @param {Map<Element, ?CSSStyleDeclaration>} [computedStyleCache] Per-walk memo.
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
 * @param {Map<Element, ?Element>} cache Per-walk memo.
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
 * Record word positions without mutating the DOM. Adjacent inline text nodes
 * form one stream, so `<span>hel</span><span>lo</span>` is one word.
 * Entries are `{ word, node, start, endNode, end }`; start and end may sit in
 * different text nodes.
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

  const ownOpacity = (element) => {
    const computed = computedOpacity(getComputedStyleSafe(element, computedStyleCache));
    if (computed != null) return computed;
    const inline = Number.parseFloat(inlineProperty(element, 'opacity', 'opacity'));
    return Number.isFinite(inline) ? inline : null;
  };

  const isAcceptedTextNode = (node, suppressed) => {
    // Empty nodes add nothing; whitespace nodes stay so adjacent words do not merge.
    if (suppressed || !node.nodeValue) return false;
    // visibility is inherited, so the parent's computed value covers hidden ancestors.
    const parent = node.parentNode;
    const parentStyle = getComputedStyleSafe(parent, computedStyleCache);
    const visibility =
      computedProperty(parentStyle, 'visibility', 'visibility') ||
      inlineProperty(parent, 'visibility', 'visibility');
    return visibility !== 'hidden' && visibility !== 'collapse';
  };

  // Ancestor state flows top-down so each element is inspected once. Opacity
  // multiplies down the tree; `suppressed` marks text under a transparent
  // ancestor or outside a collapsed <details>'s own summary. Suppressed
  // subtrees are still walked so their block boundaries separate words.
  const visit = (node, root, opacity, suppressed) => {
    if (node.nodeType === 3) {
      if (isAcceptedTextNode(node, suppressed)) appendText(node);
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
      let childOpacity = opacity;
      let childSuppressed = suppressed;
      if (!childSuppressed) {
        const own = ownOpacity(node);
        if (own != null) childOpacity *= own;
        childSuppressed = childOpacity <= 0;
      }
      const collapsedDetails = node.tagName === 'DETAILS' && !node.hasAttribute('open');
      const summary = collapsedDetails ? getOwnSummary(node, summaryCache) : null;
      for (const child of node.childNodes) {
        const hiddenByDetails = collapsedDetails && child !== summary;
        visit(child, root, childOpacity, childSuppressed || hiddenByDetails);
      }
    }
    if (boundary) flushWord();
  };

  for (const root of roots || []) {
    if (!root) continue;
    flushWord();
    visit(root, root, 1, false);
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
    // Use the owning document so ranges work inside iframes.
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

    // Search near the cursor first; distant matches need the guard below.
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
