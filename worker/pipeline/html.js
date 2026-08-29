// HTML cleaning with offset mapping back to the original HTML string.
// Single linear pass: strips <script>/<style> blocks and the subtrees the
// browser never lays out (see findUnrenderedRanges), removes other tags,
// decodes entities, collapses whitespace runs. mapping[i] = original offset
// of output[i] (and mapping[output.length] = end offset for safety).

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

// HTML's numeric character-reference parser remaps these legacy Windows-1252
// values instead of emitting their corresponding C1 control characters.
const LEGACY_C1_REPLACEMENTS = {
  0x80: 0x20ac,
  0x82: 0x201a,
  0x83: 0x0192,
  0x84: 0x201e,
  0x85: 0x2026,
  0x86: 0x2020,
  0x87: 0x2021,
  0x88: 0x02c6,
  0x89: 0x2030,
  0x8a: 0x0160,
  0x8b: 0x2039,
  0x8c: 0x0152,
  0x8e: 0x017d,
  0x91: 0x2018,
  0x92: 0x2019,
  0x93: 0x201c,
  0x94: 0x201d,
  0x95: 0x2022,
  0x96: 0x2013,
  0x97: 0x2014,
  0x98: 0x02dc,
  0x99: 0x2122,
  0x9a: 0x0161,
  0x9b: 0x203a,
  0x9c: 0x0153,
  0x9e: 0x017e,
  0x9f: 0x0178,
};

function decodeEntityAt(html, i) {
  // Returns [decodedChar, consumedLength] if entity is found at i, else null.
  if (html[i] !== '&') return null;
  const semi = html.indexOf(';', i + 1);
  if (semi < 0 || semi - i > 10) return null;
  const body = html.slice(i + 1, semi);
  if (!body) return null;
  if (body[0] === '#') {
    let code;
    if (body[1] === 'x' || body[1] === 'X') {
      code = parseInt(body.slice(2), 16);
    } else {
      code = parseInt(body.slice(1), 10);
    }
    if (!Number.isFinite(code) || code <= 0) return null;
    code = LEGACY_C1_REPLACEMENTS[code] ?? code;
    try {
      return [String.fromCodePoint(code), semi - i + 1];
    } catch {
      return null;
    }
  }
  const lower = body.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, lower)) {
    return [NAMED_ENTITIES[lower], semi - i + 1];
  }
  return null;
}

/**
 * Decodes HTML entities anywhere in a plain string (no tag handling).
 * Unrecognized or malformed entities are left as-is.
 * @param {string} str Plain text to decode.
 */
export function decodeEntities(str) {
  if (!str.includes('&')) return str;
  let out = '';
  let i = 0;
  while (i < str.length) {
    const decoded = decodeEntityAt(str, i);
    if (decoded) {
      out += decoded[0];
      i += decoded[1];
    } else {
      out += str[i];
      i++;
    }
  }
  return out;
}

function isWhitespace(ch) {
  if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v') {
    return true;
  }
  const code = ch.charCodeAt(0);
  return (
    code === 0x0085 ||
    code === 0x00a0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000
  );
}

// BMP single-code-unit characters that should be dropped entirely (emitted
// as nothing): soft hyphen, word joiner, C0 controls (excluding the
// whitespace controls handled by isWhitespace), and C1 controls / DEL. NEL
// (U+0085) is handled as whitespace before this predicate is checked.
function isStrippableFormatChar(ch) {
  const code = ch.charCodeAt(0);
  return (
    code === 0x00ad ||
    code === 0x2060 ||
    (code >= 0x00 && code <= 0x08) ||
    (code >= 0x0e && code <= 0x1f) ||
    (code >= 0x7f && code <= 0x9f)
  );
}

// Elements with no end tag: searching for one would run to the end of the
// document and swallow the rest of the article.
const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

// Contents are text, not markup, so they are never searched for hidden
// elements. The scanner in stripTagsKeepOffsets drops them on its own.
const RAW_TEXT_TAGS = new Set(['script', 'style']);

// Subtrees the browser never renders regardless of the page's own CSS.
const UNRENDERED_TAGS = new Set(['noscript', 'template']);

// Native disclosure/dialog widgets keep their contents unrendered until the
// `open` attribute is present.
const CLOSED_BY_DEFAULT_TAGS = new Set(['details', 'dialog']);

const HIDING_DECLARATION_RE =
  /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)|content-visibility\s*:\s*hidden)\s*(?:;|$)/i;

const ATTRIBUTE_RE = /([^\s"'/=<>]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]*))?/g;

/**
 * Read the tag that starts at `index`, ending it on the first `>` that is not
 * inside a quoted attribute value.
 *
 * The scanner's own `indexOf('>')` is deliberately naive, which is harmless
 * when a mis-parse only drops a tag. It is not harmless here: a `>` inside an
 * attribute would truncate the attribute list and could flip a skip decision
 * over a whole subtree, so this reader is quote-aware.
 * @param {string} html Original HTML.
 * @param {number} index Offset of the opening `<`.
 * @returns {?{name: string, closing: boolean, selfClosing: boolean, attrs: string, end: number}}
 *   Null when this is not a tag (`<!--`, a bare `<`) or it is never terminated.
 */
function readTagAt(html, index) {
  let i = index + 1;
  const closing = html[i] === '/';
  if (closing) i += 1;
  const nameStart = i;
  while (i < html.length && /[a-zA-Z0-9-]/.test(html[i])) i += 1;
  const name = html.slice(nameStart, i).toLowerCase();
  if (!name) return null;

  let quote = '';
  while (i < html.length) {
    const ch = html[i];
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      const attrs = html.slice(nameStart + name.length, i);
      return { name, closing, selfClosing: attrs.endsWith('/'), attrs, end: i + 1 };
    }
    i += 1;
  }
  return null;
}

/**
 * @param {string} attrs Raw attribute text of a tag.
 * @returns {Map<string, string>} Lower-cased attribute names to unquoted values.
 */
function parseAttributes(attrs) {
  const parsed = new Map();
  if (!attrs.trim()) return parsed;
  ATTRIBUTE_RE.lastIndex = 0;
  let match;
  while ((match = ATTRIBUTE_RE.exec(attrs))) {
    const name = match[1].toLowerCase();
    if (name === '/') continue;
    const raw = match[2] || '';
    const value =
      (raw[0] === '"' && raw.endsWith('"')) || (raw[0] === "'" && raw.endsWith("'"))
        ? raw.slice(1, -1)
        : raw;
    if (!parsed.has(name)) parsed.set(name, value);
  }
  return parsed;
}

/**
 * Whether the browser leaves this element's subtree unrendered.
 *
 * The predicate is deliberately limited to the ways of hiding content that
 * survive `sanitizeArticleHtml` (which drops `<style>`/`<link>`, so the page's
 * own stylesheet never applies in the canvas): UA-stylesheet behaviour, the
 * `hidden` attribute, and inline `style` declarations. Content hidden by a CSS
 * class is *visible* once the article is re-rendered without that stylesheet,
 * so pruning it here would drop sentences the reader can actually see.
 * @param {{name: string, attrs: string}} tag Tag as returned by readTagAt.
 * @returns {boolean}
 */
function isUnrenderedTag(tag) {
  if (UNRENDERED_TAGS.has(tag.name)) return true;
  const attributes = parseAttributes(tag.attrs);
  // `hidden` is a boolean attribute: its presence hides, whatever the value.
  if (attributes.has('hidden')) return true;
  if (CLOSED_BY_DEFAULT_TAGS.has(tag.name) && !attributes.has('open')) return true;
  return HIDING_DECLARATION_RE.test(attributes.get('style') || '');
}

/**
 * Offset just past the end tag matching an element opened at `from`, counting
 * nested elements of the same name and ignoring comments and raw-text content.
 * @param {string} html Original HTML.
 * @param {string} name Lower-cased tag name.
 * @param {number} from Offset just past the opening tag.
 * @returns {{closeStart: number, end: number}} Both are `html.length` when the
 *   element is never closed, which drops the remainder — the same lenient
 *   choice the scanner already makes for an unclosed `<script>`.
 */
function findElementEnd(html, name, from) {
  let depth = 1;
  let i = from;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) break;
    if (html.startsWith('<!--', lt)) {
      const commentEnd = html.indexOf('-->', lt + 4);
      i = commentEnd < 0 ? html.length : commentEnd + 3;
      continue;
    }
    const tag = readTagAt(html, lt);
    if (!tag) {
      i = lt + 1;
      continue;
    }
    if (tag.name === name) {
      if (tag.closing) {
        depth -= 1;
        if (depth === 0) return { closeStart: lt, end: tag.end };
      } else if (!tag.selfClosing && !VOID_TAGS.has(name)) {
        depth += 1;
      }
    } else if (!tag.closing && RAW_TEXT_TAGS.has(tag.name)) {
      i = findElementEnd(html, tag.name, tag.end).end;
      continue;
    }
    i = tag.end;
  }
  return { closeStart: html.length, end: html.length };
}

/**
 * Locate the `<summary>` a closed `<details>` still renders: the first one that
 * is not owned by a nested `<details>`.
 * @param {string} html Original HTML.
 * @param {number} from Offset just past the `<details>` opening tag.
 * @param {number} until Offset of the matching `</details>`.
 * @returns {?{start: number, end: number}}
 */
function findSummaryRange(html, from, until) {
  let nested = 0;
  let i = from;
  while (i < until) {
    const lt = html.indexOf('<', i);
    if (lt < 0 || lt >= until) break;
    if (html.startsWith('<!--', lt)) {
      const commentEnd = html.indexOf('-->', lt + 4);
      i = commentEnd < 0 ? until : commentEnd + 3;
      continue;
    }
    const tag = readTagAt(html, lt);
    if (!tag) {
      i = lt + 1;
      continue;
    }
    if (tag.name === 'details' && !tag.selfClosing) {
      nested += tag.closing ? -1 : 1;
    } else if (tag.name === 'summary' && !tag.closing && nested === 0) {
      const { end } = findElementEnd(html, 'summary', tag.end);
      return { start: lt, end: Math.min(end, until) };
    }
    i = tag.end;
  }
  return null;
}

/**
 * Ranges of `html` that the browser never lays out, as sorted, non-overlapping
 * `[start, end)` offsets.
 *
 * Text inside them must not become a sentence: the canvas positions its topic
 * cards from the measured on-screen rect of each sentence, and a sentence that
 * resolves to no rect falls back to a synthetic ladder position, mixing two
 * coordinate spaces in one rail column.
 * @param {string} html Original HTML.
 * @returns {Array<{start: number, end: number}>}
 */
export function findUnrenderedRanges(html) {
  const ranges = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) break;
    if (html.startsWith('<!--', lt)) {
      const commentEnd = html.indexOf('-->', lt + 4);
      i = commentEnd < 0 ? html.length : commentEnd + 3;
      continue;
    }
    const tag = readTagAt(html, lt);
    if (!tag) {
      i = lt + 1;
      continue;
    }
    if (!tag.closing && RAW_TEXT_TAGS.has(tag.name) && !tag.selfClosing) {
      i = findElementEnd(html, tag.name, tag.end).end;
      continue;
    }
    if (tag.closing || tag.selfClosing || VOID_TAGS.has(tag.name) || !isUnrenderedTag(tag)) {
      i = tag.end;
      continue;
    }
    const { closeStart, end } = findElementEnd(html, tag.name, tag.end);
    // A collapsed <details> still renders its summary, which on a FAQ-style
    // page carries real content (the question), so it is kept in place.
    const summary = tag.name === 'details' ? findSummaryRange(html, tag.end, closeStart) : null;
    if (summary) {
      ranges.push({ start: lt, end: summary.start }, { start: summary.end, end });
    } else {
      ranges.push({ start: lt, end });
    }
    i = end;
  }
  return ranges;
}

export function stripTagsKeepOffsets(html) {
  const out = [];
  const mapping = [];
  let lastWasSpace = true; // suppress leading whitespace
  let i = 0;
  const n = html.length;
  // `html` is immutable throughout the scan. Cache a lower-cased copy on
  // demand for case-insensitive closing script/style tag searches, avoiding
  // repeated full-document normalization without penalizing documents that
  // contain neither tag.
  let htmlLower = null;
  // Subtrees the browser never lays out, consumed in order as the scan reaches
  // them. Text inside them would otherwise become sentences that no on-screen
  // rect can ever be measured for.
  const unrenderedRanges = findUnrenderedRanges(html);
  let nextRange = 0;

  const pushChar = (ch, origPos) => {
    if (isWhitespace(ch)) {
      if (lastWasSpace) return;
      out.push(' ');
      mapping.push(origPos);
      lastWasSpace = true;
    } else if (isStrippableFormatChar(ch)) {
      return;
    } else {
      out.push(ch);
      mapping.push(origPos);
      lastWasSpace = false;
    }
  };

  while (i < n) {
    // Ranges already behind the cursor (e.g. one nested inside a <script>
    // block the branch below jumped over) are dropped rather than re-applied,
    // so a skip can never rewind or swallow text the cursor has passed.
    while (nextRange < unrenderedRanges.length && unrenderedRanges[nextRange].start < i) {
      nextRange += 1;
    }
    if (nextRange < unrenderedRanges.length && unrenderedRanges[nextRange].start === i) {
      i = unrenderedRanges[nextRange].end;
      nextRange += 1;
      // Treat as a whitespace separator, exactly as for a <script> block.
      pushChar(' ', i);
      continue;
    }
    const ch = html[i];
    if (ch === '<') {
      // Detect <script> or <style> blocks (skip including content).
      const lowered = html.slice(i, i + 9).toLowerCase();
      let blockTag = null;
      if (
        lowered.startsWith('<script') &&
        (lowered[7] === ' ' ||
          lowered[7] === '>' ||
          lowered[7] === '\t' ||
          lowered[7] === '\n' ||
          lowered[7] === '/' ||
          lowered[7] === undefined)
      ) {
        blockTag = 'script';
      } else if (
        lowered.startsWith('<style') &&
        (lowered[6] === ' ' ||
          lowered[6] === '>' ||
          lowered[6] === '\t' ||
          lowered[6] === '\n' ||
          lowered[6] === '/' ||
          lowered[6] === undefined)
      ) {
        blockTag = 'style';
      }
      if (blockTag) {
        const closing = '</' + blockTag;
        const tagEnd = html.indexOf('>', i);
        if (tagEnd < 0) {
          i = n;
          break;
        }
        // Find closing tag (case-insensitive).
        if (htmlLower === null) htmlLower = html.toLowerCase();
        const closeIdx = htmlLower.indexOf(closing, tagEnd + 1);
        if (closeIdx < 0) {
          i = n;
          break;
        }
        const closeEnd = html.indexOf('>', closeIdx);
        i = closeEnd < 0 ? n : closeEnd + 1;
        // Treat as a whitespace separator.
        pushChar(' ', i);
        continue;
      }
      // Generic tag: skip from < to matching >.
      const tagEnd = html.indexOf('>', i);
      if (tagEnd < 0) {
        i = n;
        break;
      }
      // A tag boundary acts as a whitespace separator so words don't fuse.
      pushChar(' ', tagEnd + 1);
      i = tagEnd + 1;
      continue;
    }
    if (ch === '&') {
      const decoded = decodeEntityAt(html, i);
      if (decoded) {
        const [str, consumed] = decoded;
        // The mapping contract uses JavaScript string offsets (UTF-16 code
        // units), not Unicode code points. Iterating with `for...of` would push
        // an astral character such as 😀 as one array entry even though it
        // occupies two offsets in the joined output string. Push each code unit
        // separately so mapping.length always remains text.length + 1.
        for (let codeUnit = 0; codeUnit < str.length; codeUnit++) {
          pushChar(str[codeUnit], i);
        }
        i += consumed;
        continue;
      }
    }
    pushChar(ch, i);
    i++;
  }

  // Strip Unicode Tags-block characters (U+E0000-U+E007F) unless they are part
  // of a legitimate flag sequence (immediately preceded by U+1F3F4 WAVING BLACK
  // FLAG and forming a contiguous Tags-block run). This is an invisible
  // prompt-injection channel, but subdivision-flag emoji (e.g. England,
  // Scotland, Wales) legitimately use it, so those must be preserved.
  const flagFilteredOut = [];
  const flagFilteredMapping = [];
  let inFlagContext = false;
  let k = 0;
  while (k < out.length) {
    const cu = out[k].charCodeAt(0);
    let cp = cu;
    let unitLen = 1;
    if (cu >= 0xd800 && cu <= 0xdbff && k + 1 < out.length) {
      const lo = out[k + 1].charCodeAt(0);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        cp = (cu - 0xd800) * 0x400 + (lo - 0xdc00) + 0x10000;
        unitLen = 2;
      }
    }
    const isTag = cp >= 0xe0000 && cp <= 0xe007f;
    let keep = true;
    if (cp === 0x1f3f4) {
      inFlagContext = true;
    } else if (isTag) {
      if (inFlagContext) {
        if (cp === 0xe007f) inFlagContext = false;
      } else {
        keep = false;
      }
    } else {
      inFlagContext = false;
    }
    if (keep) {
      flagFilteredOut.push(out[k]);
      flagFilteredMapping.push(mapping[k]);
      if (unitLen === 2) {
        flagFilteredOut.push(out[k + 1]);
        flagFilteredMapping.push(mapping[k + 1]);
      }
    }
    k += unitLen;
  }

  // Filter out runs of target zero-width characters (ZWSP, ZWNJ, ZWJ, BOM) >= 4 in length.
  const targetChars = new Set(['\u200b', '\u200c', '\u200d', '\ufeff']);
  const filteredOut = [];
  const filteredMapping = [];
  let startIdx = 0;
  const len = flagFilteredOut.length;

  while (startIdx < len) {
    if (targetChars.has(flagFilteredOut[startIdx])) {
      let endIdx = startIdx + 1;
      while (endIdx < len && targetChars.has(flagFilteredOut[endIdx])) {
        endIdx++;
      }
      const runLength = endIdx - startIdx;
      if (runLength >= 4) {
        // Suspicious run of zero-width characters: strip completely.
      } else {
        // Legitimate run of zero-width characters: keep all of them.
        for (let k2 = startIdx; k2 < endIdx; k2++) {
          filteredOut.push(flagFilteredOut[k2]);
          filteredMapping.push(flagFilteredMapping[k2]);
        }
      }
      startIdx = endIdx;
    } else {
      filteredOut.push(flagFilteredOut[startIdx]);
      filteredMapping.push(flagFilteredMapping[startIdx]);
      startIdx++;
    }
  }

  // Collapse consecutive spaces that might have been left adjacent after stripping.
  const collapsedOut = [];
  const collapsedMapping = [];
  let lastWasSpaceFiltered = true; // suppress revealed leading whitespace
  for (let k = 0; k < filteredOut.length; k++) {
    const ch = filteredOut[k];
    if (ch === ' ') {
      if (lastWasSpaceFiltered) continue;
      collapsedOut.push(' ');
      collapsedMapping.push(filteredMapping[k]);
      lastWasSpaceFiltered = true;
    } else {
      collapsedOut.push(ch);
      collapsedMapping.push(filteredMapping[k]);
      lastWasSpaceFiltered = false;
    }
  }

  // Trim trailing whitespace.
  while (collapsedOut.length > 0 && collapsedOut[collapsedOut.length - 1] === ' ') {
    collapsedOut.pop();
    collapsedMapping.pop();
  }
  // Sentinel for end offset.
  collapsedMapping.push(n);
  return { text: collapsedOut.join(''), mapping: collapsedMapping };
}
