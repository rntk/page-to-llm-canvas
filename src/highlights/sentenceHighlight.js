// Shared helpers for locating record sentences inside a live DOM subtree and
// painting them with the native CSS Custom Highlight API. Used by both the
// in-page rail (src/content/rails/in-page/pageHighlighter.js, operating on the
// live page) and the canvas modal (src/canvas/App.jsx, operating on the
// re-rendered article HTML).
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
/** CSS Custom Highlight name for chat-driven sentence highlights, shared by
 * the canvas (src/chat/useChatHighlights.js) and the in-page rail
 * (src/content/rails/in-page/pageHighlighter.js) so both surfaces render chat
 * highlights identically via ::highlight(pagetollm-chat-sentence). */
export const CHAT_HIGHLIGHT_NAME = 'pagetollm-chat-sentence';

export function supportsHighlightApi() {
  return typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight !== 'undefined';
}

export function tokenizeText(text) {
  return String(text || '').match(WORD_TOKEN_RE) || [];
}

// Properties which suppress an entire subtree. Computed styles are preferred
// when available (so stylesheet/class rules are respected); the inline parser
// remains as a fallback for DOM shims and callers without a style engine.
const HIDING_VALUES = new Map([
  ['display', 'none'],
  ['content-visibility', 'hidden'],
]);

const IMPORTANT_SUFFIX_RE = /!\s*important$/;

/**
 * Split an inline `style` attribute into its declarations.
 *
 * A plain `split(';')` cuts inside quoted values and `url(...)`, inventing
 * declarations that were never written, so `--x:';display:none;'` would hide
 * a visible element. This fallback is used when a complete computed style is
 * unavailable (notably in DOM-only test environments).
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
 * The rules align the live-page word walk with browser-side capture filtering:
 * a word omitted from `capturedText` must not appear here, or
 * `buildSentenceWordRanges` maps later sentences onto the wrong DOM words.
 * Computed `display` and `content-visibility` are included when the browser
 * exposes them; attribute and inline checks remain the fallback.
 *
 * A closed `<details>` is deliberately not skippable: it still renders its
 * `<summary>`. Its remaining contents are excluded by the walk in
 * `collectWordEntries` instead.
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
  // Treat explicit HTML hiding as authoritative. Although author CSS can
  // technically override the UA [hidden] rule, retaining that text is a much
  // riskier failure for analysis and it would not survive the stored snapshot.
  if (node.hasAttribute('hidden')) return true;
  if (CLOSED_BY_DEFAULT_TAGS.has(tag) && !node.hasAttribute('open')) return true;
  const computed = getComputedStyleSafe(node, computedStyleCache);
  // A complete computed style is authoritative: an author rule with
  // `!important` can override a normal inline declaration. DOM shims may
  // expose getComputedStyle without returning layout properties, so retain the
  // parser fallback in that case.
  if (computedStyleHasLayoutValues(computed)) {
    return computedSubtreeIsHidden(computed);
  }
  return hasHidingDeclaration(node.getAttribute('style') || '');
}

/**
 * The `<summary>` a collapsed `<details>` still renders: its first *direct*
 * child. A `<summary>` deeper in the subtree (wrapped in a `<div>`, or owned by
 * a nested `<details>`) is not this widget's summary and stays hidden, so the
 * scan is over `children` rather than a descendant query.
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
 * Whether `ancestor` is a collapsed `<details>` that hides `node` — i.e. `node`
 * lives outside the `<summary>` the widget keeps on screen.
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
 * Walk rendered text within roots and record each word's position WITHOUT
 * mutating the DOM. Adjacent inline text nodes share one logical stream, so a
 * word split as `<span>hel</span><span>lo</span>` is represented as one entry.
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
    // Whitespace-only visible nodes are significant boundaries in the logical
    // stream. appendText() consumes them and flushes the current word; skipping
    // them here would fuse `<b>foo</b> <i>bar</i>` into one `foobar` entry.
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
    // Keep the boundary behavior of the capture walker even when a subtree is
    // suppressed: its block separation still prevents adjacent visible text
    // from being joined across the omitted block.
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
    // The entries come from the live document being highlighted. Constructing
    // through the node's ownerDocument keeps this helper correct for embedded
    // or otherwise non-global documents (e.g. an iframe or SVG/XML surface).
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
 * Build (or clear) a single named CSS Custom Highlight from a list of
 * sentence numbers. Resolves one live Range per sentence via
 * buildSentenceDomRange, adds every resolved range to a fresh Highlight, and
 * registers it under `name`. Deletes the highlight when sentenceNumbers is
 * empty/nullish or no range resolved. Callers are expected to have already
 * checked supportsHighlightApi().
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
 * Both ends are anchored to actual DOM words instead of trusting a 1:1 token
 * count to handle tokenization drift (e.g. punctuation, em-dashes). Start matches
 * the first token in a forward window; if that fails, a distant fallback requires
 * the first two tokens to match consecutively. The end matches the last token in a
 * window near the expected end. These guards keep distant false positives from
 * advancing the cursor past later sentences while still tolerating large DOM drift.
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
    // Punctuation-only tokens cannot anchor a sentence to a DOM word. Ignore
    // them for matching rather than allowing an empty normalized token to
    // match an unrelated punctuation entry.
    const normalizedTokens = tokens.map(normalize).filter(Boolean);
    if (normalizedTokens.length === 0) return;

    // Anchor the start near the cursor first. Live pages can insert arbitrarily
    // large blocks after capture, though, so a fixed window cannot be the only
    // recovery path: once the drift exceeds it, every later sentence would
    // otherwise remain permanently unmapped. Fall back to the rest of the
    // document only with stronger corroboration than the nearby search needs.
    const targetFirst = normalizedTokens[0];
    let startIdx = -1;
    const nearbyEnd = Math.min(norm.length, cursor + START_WINDOW);
    for (let k = cursor; k < nearbyEnd; k++) {
      if (norm[k] === targetFirst) {
        startIdx = k;
        break;
      }
    }
    // A distant single-token match is too weak to move the cursor safely. For
    // longer sentences, require a consecutive two-token prefix before the
    // existing end-anchor check supplies the final corroboration.
    if (startIdx === -1 && normalizedTokens.length >= 2) {
      for (let k = nearbyEnd; k < norm.length; k++) {
        if (norm[k] === targetFirst && norm[k + 1] === normalizedTokens[1]) {
          startIdx = k;
          break;
        }
      }
    }
    // A failed anchor is an unmapped sentence. Crucially, leave cursor where it
    // was so a subsequent sentence can search from the last known position and
    // resynchronize instead of inheriting a fabricated range.
    if (startIdx === -1) return;

    // Position the end would land at if tokens mapped 1:1 with DOM words.
    const expectedEnd = Math.min(norm.length - 1, startIdx + normalizedTokens.length - 1);

    let endIdx;
    if (normalizedTokens.length === 1) {
      endIdx = startIdx;
    } else {
      // Anchor the end: last token nearest the expected end position, so token
      // drift doesn't run the range past the sentence's true final word.
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
      // Do not fall back to the expected position. If the end token is absent,
      // mapping a guessed range would advance cursor past real DOM content and
      // make every following sentence less trustworthy. Keep cursor unchanged
      // so a later sentence can still recover.
      if (best < startIdx) return;
      endIdx = best;
    }

    ranges.set(i + 1, { startIdx, endIdx });
    cursor = endIdx + 1;
  });

  return ranges;
}
