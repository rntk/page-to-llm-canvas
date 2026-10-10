// Simplified port of txt_splitt's SparseRegexSentenceSplitter: terminal
// boundaries, long-span anchoring, and short-span merging across scripts.
// Pieces cut from a long sentence by anchoring carry `continued: true`, so
// consumers can tell an anchor cut from a real sentence boundary.

const CLOSING = `"'”’)\\]»›」』）】》〉〕`;
const TERMINAL = `.!?…。！？؟।॥`;
// CJK full-width stops are written without a following space, so they may end a
// sentence with an empty gap; every other mark still requires whitespace.
const SPACELESS_TERMINAL_RE = /[。！？]/u;
// Stateful (`g`): reset `lastIndex` before every `exec` scan.
const TERMINAL_RE = new RegExp(`([${TERMINAL}])[${CLOSING}]*(\\s*)`, 'gu');
// Uppercase/titlecase where a script has case, any letter where it does not
// (Han, kana, Hebrew, Arabic, Devanagari, ... are all `Lo`), plus openers.
const SENTENCE_START_RE = /[\p{Lu}\p{Lt}\p{Lo}\p{N}"'([{“‘«‹„¿¡「『（【《〈]/u;
const WHITESPACE_RE = /\s/;
// Count unspaced Han and kana characters as words so short-span merging does
// not collapse entire passages. Korean uses the whitespace branch.
const UNSPACED = '\\p{sc=Han}\\p{sc=Hiragana}\\p{sc=Katakana}';
// Stateful (`g`): reset `lastIndex` before every `exec` scan.
const WORD_RE = new RegExp(`[${UNSPACED}]|[^\\s${UNSPACED}]+`, 'gu');

function countWords(text, start, end) {
  let n = 0;
  const slice = text.slice(start, end);
  WORD_RE.lastIndex = 0;
  while (WORD_RE.exec(slice)) n++;
  return n;
}

function trimWs(text, start, end) {
  while (start < end && WHITESPACE_RE.test(text[start])) start++;
  while (end > start && WHITESPACE_RE.test(text[end - 1])) end--;
  return [start, end];
}

function collectTerminalBoundaries(text) {
  const out = [];
  TERMINAL_RE.lastIndex = 0;
  let m;
  while ((m = TERMINAL_RE.exec(text)) !== null) {
    const gapStart = m.index + m[0].length - m[2].length;
    const gapEnd = m.index + m[0].length;
    if (gapEnd >= text.length) continue;
    if (m[2].length === 0 && !SPACELESS_TERMINAL_RE.test(m[1])) continue;
    const nextCh = String.fromCodePoint(text.codePointAt(gapEnd));
    if (!SENTENCE_START_RE.test(nextCh)) continue;
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
  WORD_RE.lastIndex = 0;
  const slice = text.slice(start, end);
  let m;
  while ((m = WORD_RE.exec(slice)) !== null) {
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
    let cut = -1;
    for (let p = wordEnd; p < end; p++) {
      if (WHITESPACE_RE.test(text[p])) {
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
  // Every piece after the first continues the same sentence.
  return result.length > 0 ? result.map(([s, e], index) => [s, e, index > 0]) : [[start, end]];
}

function mergeShortNonterminal(text, spans, minWords) {
  if (spans.length === 0) return spans;
  const out = [spans[0].slice()];
  for (let i = 1; i < spans.length; i++) {
    const [s, e] = spans[i];
    const words = countWords(text, s, e);
    if (words < minWords) {
      out[out.length - 1][1] = e;
    } else {
      out.push(spans[i].slice());
    }
  }
  if (out.length >= 2 && countWords(text, out[0][0], out[0][1]) < minWords) {
    out[1][0] = out[0][0];
    out[1][2] = out[0][2];
    out.shift();
  }
  return out;
}

export function splitSentences(text, opts = {}) {
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

  return spans.map(([s, e, continued]) => ({
    text: text.slice(s, e),
    start: s,
    end: e,
    ...(continued ? { continued: true } : {}),
  }));
}
