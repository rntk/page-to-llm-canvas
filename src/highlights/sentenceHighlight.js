// Shared helpers for locating record sentences inside a live DOM subtree and
// painting them with the native CSS Custom Highlight API. Used by both the
// in-page rail (src/content/main.jsx, operating on the live page) and the
// canvas modal (src/canvas/App.jsx, operating on the re-rendered article HTML).

const WORD_TOKEN_RE = /\S+/g;
export const HIGHLIGHT_NAME = 'pagetollm-sentence';
/** CSS Custom Highlight name for chat-driven sentence highlights, shared by
 * the canvas (src/chat/useChatHighlights.js) and the in-page rail
 * (src/content/inPageRailController.jsx) so both surfaces render chat
 * highlights identically via ::highlight(pagetollm-chat-sentence). */
export const CHAT_HIGHLIGHT_NAME = 'pagetollm-chat-sentence';

export function supportsHighlightApi() {
  return typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight !== 'undefined';
}

export function tokenizeText(text) {
  return String(text || '').match(WORD_TOKEN_RE) || [];
}

export function isSkippableContainer(node) {
  if (!node || node.nodeType !== 1) return false;
  const tag = node.tagName;
  if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return true;
  if (node.id === 'pagetollm-in-page-rail') return true;
  return false;
}

/**
 * Walk text nodes within roots and record each word's position WITHOUT mutating
 * the DOM. Returns the global ordered list of word entries:
 * [{ word, node, start, end }] where node/start/end locate the word inside a
 * live text node, suitable for building a Range.
 */
export function collectWordEntries(roots) {
  const entries = [];
  const textNodes = [];
  const walker = (root) => {
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        let p = node.parentNode;
        while (p && p !== root.parentNode) {
          if (isSkippableContainer(p)) return NodeFilter.FILTER_REJECT;
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
 */
export function buildSentenceWordRanges(sentences, wordEntries) {
  const ranges = new Map();
  const normalize = (s) =>
    String(s)
      .toLowerCase()
      .replace(/[^a-z0-9]+/gi, '');
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
