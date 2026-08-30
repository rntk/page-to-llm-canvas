// Shared helpers for locating record sentences inside a live DOM subtree and
// painting them with the native CSS Custom Highlight API. Used by both the
// in-page rail (src/content/rails/in-page/pageHighlighter.js, operating on the
// live page) and the canvas modal (src/canvas/App.jsx, operating on the
// re-rendered article HTML).

// Stateful (`g`): reset `lastIndex` before every `exec` scan.
const WORD_TOKEN_RE = /\S+/g;
// Stateful (`g`), but String#replace resets it before matching.
const NORMALIZE_RE = /[^a-z0-9]+/gi;
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

// Tags whose whole subtree the browser never lays out (plus the ones whose
// contents are markup-free), so no word inside them can ever be measured.
const UNRENDERED_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);

// Same properties worker/pipeline/html.js prunes from the record text; see the
// note there on why `visibility` is not one of them (`visibility:hidden` still
// generates measurable line boxes and a descendant can override it).
const HIDING_VALUES = new Map([
  ['display', 'none'],
  ['content-visibility', 'hidden'],
]);

const IMPORTANT_SUFFIX_RE = /!\s*important$/;

/**
 * Split an inline `style` attribute into its declarations.
 *
 * Mirrors `splitDeclarations` in worker/pipeline/html.js: a plain `split(';')`
 * cuts inside quoted values and `url(...)`, inventing declarations that were
 * never written, so `--x:';display:none;'` would hide a visible element.
 *
 * `node.style` (CSSOM) would parse this exactly, but it only exists on this
 * side — the worker has no DOM. Using it here would make the two
 * implementations disagree on every input they parse imprecisely, which is the
 * one failure mode that corrupts sentence-to-word alignment.
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
 * Mirrors `hasHidingDeclaration` in worker/pipeline/html.js, including its
 * cascade handling: a later declaration wins (`display:none;display:block`
 * renders), except that a normal declaration never overrides an important one.
 * The two must agree exactly on which text survives.
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
 * The rules mirror `isUnrenderedTag` in worker/pipeline/html.js, which prunes
 * the same subtrees from the record's `text` (and therefore its sentences): a
 * word the pipeline dropped must not appear here either, or `buildSentenceWordRanges`
 * maps every later sentence onto the wrong DOM words and the canvas rail loses
 * their positions entirely. Only attribute-level hiding counts — the UA
 * stylesheet, `hidden`, and inline `style`. Content hidden by a CSS *class* is
 * visible again in the canvas (which re-renders the article without the page's
 * stylesheet) and the pipeline keeps it, so it must stay here too.
 *
 * A closed `<details>` is deliberately not skippable: it still renders its
 * `<summary>`. Its remaining contents are excluded by the walk in
 * `collectWordEntries` instead.
 * @param {Node} node Candidate ancestor of a text node.
 * @returns {boolean}
 */
export function isSkippableContainer(node) {
  if (!node || node.nodeType !== 1) return false;
  const tag = node.tagName;
  if (UNRENDERED_TAGS.has(tag)) return true;
  if (node.id === 'pagetollm-in-page-rail') return true;
  if (typeof node.hasAttribute !== 'function') return false;
  // `hidden` is a boolean attribute: its presence hides, whatever the value.
  if (node.hasAttribute('hidden')) return true;
  if (tag === 'DIALOG' && !node.hasAttribute('open')) return true;
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
 * Walk text nodes within roots and record each word's position WITHOUT mutating
 * the DOM. Returns the global ordered list of word entries:
 * [{ word, node, start, end }] where node/start/end locate the word inside a
 * live text node, suitable for building a Range.
 * @param {Node[]} roots DOM roots to traverse.
 */
export function collectWordEntries(roots) {
  const entries = [];
  const textNodes = [];
  const summaryCache = new Map();
  const walker = (root) => {
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        let p = node.parentNode;
        while (p && p !== root.parentNode) {
          if (isSkippableContainer(p) || isCollapsedDetailsContent(p, node, summaryCache)) {
            return NodeFilter.FILTER_REJECT;
          }
          p = p.parentNode;
        }
        if (!node.nodeValue || !node.nodeValue.trim()) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n;
    while ((n = tw.nextNode())) textNodes.push(n);
  };
  roots.forEach(walker);

  for (const textNode of textNodes) {
    const value = textNode.nodeValue;
    WORD_TOKEN_RE.lastIndex = 0;
    let m;
    while ((m = WORD_TOKEN_RE.exec(value))) {
      entries.push({
        word: m[0],
        node: textNode,
        start: m.index,
        end: m.index + m[0].length,
      });
    }
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
    const domRange = document.createRange();
    domRange.setStart(startEntry.node, startEntry.start);
    domRange.setEnd(endEntry.node, endEntry.end);
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
 * the first token in a forward window; end matches the last token in a window near
 * the expected end. Anchoring the end prevents highlights from overshooting.
 * @param {string[]} sentences Article sentences.
 * @param {object[]} wordEntries Ordered DOM word entries.
 */
export function buildSentenceWordRanges(sentences, wordEntries) {
  const ranges = new Map();
  const normalize = (s) =>
    String(s)
      .toLowerCase()
      .replace(NORMALIZE_RE, '');
  const norm = wordEntries.map((e) => normalize(e.word));
  const START_WINDOW = 80;
  const END_WINDOW = 12;
  let cursor = 0;

  sentences.forEach((sentText, i) => {
    const tokens = tokenizeText(sentText);
    if (tokens.length === 0) return;

    // Anchor the start: first token within a forward window from the cursor.
    const targetFirst = normalize(tokens[0]);
    let startIdx = -1;
    for (let k = cursor; k < Math.min(norm.length, cursor + START_WINDOW); k++) {
      if (norm[k] === targetFirst) {
        startIdx = k;
        break;
      }
    }
    if (startIdx === -1) startIdx = cursor;

    // Position the end would land at if tokens mapped 1:1 with DOM words.
    const expectedEnd = Math.min(norm.length - 1, startIdx + tokens.length - 1);

    let endIdx;
    if (tokens.length === 1) {
      endIdx = startIdx;
    } else {
      // Anchor the end: last token nearest the expected end position, so token
      // drift doesn't run the range past the sentence's true final word.
      const targetLast = normalize(tokens[tokens.length - 1]);
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
      endIdx = best >= startIdx ? best : expectedEnd;
    }

    ranges.set(i + 1, { startIdx, endIdx });
    cursor = endIdx + 1;
  });

  return ranges;
}
