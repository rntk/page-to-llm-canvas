// Simplified port of txt_splitt/sentences/splitters.py SparseRegexSentenceSplitter.
// Faithful to terminal-boundary + anchor-long-sentence + merge-short behavior;
// drops html_aware, quote_aware, paired-region, abbreviation handling beyond a
// short list, and signal-kind merging refinements.

const CLOSING = `"'”’)\\]»`;
const TERMINAL_RE = new RegExp(`([.!?…])[${CLOSING}]*(\\s+)`, 'g');
const SENTENCE_START_RE = /[A-Z0-9À-ɏ"'([{“‘«]/;
const ABBREVS = new Set([
  'Mr.',
  'Mrs.',
  'Ms.',
  'Dr.',
  'Prof.',
  'Gen.',
  'Gov.',
  'Sgt.',
  'Col.',
  'Capt.',
]);

function countWords(text, start, end) {
  let n = 0;
  const slice = text.slice(start, end);
  const re = /\S+/g;
  while (re.exec(slice)) n++;
  return n;
}

function trimWs(text, start, end) {
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  return [start, end];
}

function precededByAbbrev(text, punctPos) {
  let s = punctPos - 1;
  while (s >= 0 && !/\s/.test(text[s])) s--;
  s++;
  return ABBREVS.has(text.slice(s, punctPos + 1));
}

function collectTerminalBoundaries(text) {
  const out = [];
  TERMINAL_RE.lastIndex = 0;
  let m;
  while ((m = TERMINAL_RE.exec(text)) !== null) {
    const punctEnd = m.index + 1;
    const gapStart = m.index + m[0].length - m[2].length;
    const gapEnd = m.index + m[0].length;
    if (gapEnd >= text.length) continue;
    const nextCh = text[gapEnd];
    if (!SENTENCE_START_RE.test(nextCh)) continue;
    if (text[punctEnd - 1] === '.' && precededByAbbrev(text, punctEnd - 1)) continue;
    out.push([gapStart, gapEnd]);
  }
  return out;
}

function splitSpans(text, boundaries) {
  const spans = [];
  let start = 0;
  for (const [bs, be] of boundaries) {
    const [s, e] = trimWs(text, start, bs);
    if (s < e) spans.push([s, e]);
    start = be;
  }
  const [s, e] = trimWs(text, start, text.length);
  if (s < e) spans.push([s, e]);
  return spans;
}

function anchorLongSpan(text, start, end, anchorEvery, longThreshold, minWords) {
  const wordPositions = [];
  const re = /\S+/g;
  re.lastIndex = 0;
  const slice = text.slice(start, end);
  let m;
  while ((m = re.exec(slice)) !== null) {
    wordPositions.push([start + m.index, start + m.index + m[0].length]);
  }
  if (wordPositions.length <= longThreshold) return [[start, end]];

  const result = [];
  let cursor = start;
  let wi = 0;
  while (wi < wordPositions.length) {
    const remaining = wordPositions.length - wi;
    if (remaining <= longThreshold) {
      const [s, e] = trimWs(text, cursor, end);
      if (s < e) result.push([s, e]);
      break;
    }
    const take = Math.min(anchorEvery, remaining - minWords);
    if (take <= 0) {
      const [s, e] = trimWs(text, cursor, end);
      if (s < e) result.push([s, e]);
      break;
    }
    const wordEnd = wordPositions[wi + take - 1][1];
    // Find whitespace cut at/after wordEnd.
    let cut = -1;
    for (let p = wordEnd; p < end; p++) {
      if (/\s/.test(text[p])) {
        cut = p;
        break;
      }
    }
    if (cut < 0 || cut <= cursor) {
      const [s, e] = trimWs(text, cursor, end);
      if (s < e) result.push([s, e]);
      break;
    }
    const [s, e] = trimWs(text, cursor, cut);
    if (s < e) result.push([s, e]);
    cursor = cut;
    while (wi < wordPositions.length && wordPositions[wi][0] < cursor) wi++;
  }
  return result.length > 0 ? result : [[start, end]];
}

function mergeShortNonterminal(text, spans, minWords) {
  if (spans.length === 0) return spans;
  const out = [spans[0].slice()];
  for (let i = 1; i < spans.length; i++) {
    const [s, e] = spans[i];
    const words = countWords(text, s, e);
    if (words < minWords) {
      // Merge into previous.
      out[out.length - 1][1] = e;
    } else {
      out.push([s, e]);
    }
  }
  // Also: if first span is short, merge into next.
  if (out.length >= 2 && countWords(text, out[0][0], out[0][1]) < minWords) {
    out[1][0] = out[0][0];
    out.shift();
  }
  return out;
}

export function splitSentences(text, opts = {}) {
  // Ported from txt_splitt/sentences/splitters.py SparseRegexSentenceSplitter.split
  if (!text || !text.trim()) return [];
  const anchorEvery = opts.anchorEveryWords ?? 12;
  const longThreshold = opts.longSentenceWordThreshold ?? 24;
  const minWords = opts.minSentenceWords ?? 4;

  const boundaries = collectTerminalBoundaries(text);
  let spans = splitSpans(text, boundaries);

  const anchored = [];
  for (const [s, e] of spans) {
    anchored.push(...anchorLongSpan(text, s, e, anchorEvery, longThreshold, minWords));
  }
  spans = mergeShortNonterminal(text, anchored, minWords);

  return spans.map(([s, e]) => ({ text: text.slice(s, e), start: s, end: e }));
}
