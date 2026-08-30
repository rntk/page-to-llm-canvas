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

// RCDATA elements: entities are decoded inside them but markup is not, so a
// `<b>` in their content is text. Only the direct-child depth scan needs this —
// the tag scanner treats their contents as ordinary text either way.
const RCDATA_TAGS = new Set(['textarea', 'title']);

// Subtrees the browser never renders regardless of the page's own CSS.
const UNRENDERED_TAGS = new Set(['noscript', 'template']);

// Native disclosure/dialog widgets keep their contents unrendered until the
// `open` attribute is present.
const CLOSED_BY_DEFAULT_TAGS = new Set(['details', 'dialog']);

// Properties whose value can suppress layout entirely and that a descendant
// cannot override. `visibility` is deliberately absent: `visibility:hidden`
// still generates line boxes, so its text measures to a real rect, and a
// descendant can turn itself back on with `visibility:visible` — pruning the
// ancestor's subtree would drop sentences the reader can see.
const HIDING_VALUES = new Map([
  ['display', 'none'],
  ['content-visibility', 'hidden'],
]);

const IMPORTANT_SUFFIX_RE = /!\s*important$/;

/**
 * Split an inline `style` attribute into its declarations.
 *
 * A plain `split(';')` cuts inside quoted values and `url(...)`, inventing
 * declarations that were never written — `--x:';display:none;'` would hide a
 * visible element. Quotes, CSS comments and parentheses are therefore tracked,
 * and only a top-level `;` outside all of them ends a declaration.
 *
 * Two imprecisions remain, both erring towards *keeping* text (a false positive
 * would drop content the reader can see, which is the failure that matters): a
 * comment interrupting a property name leaves that comment in the name, so the
 * declaration never matches, and an unterminated quote swallows the rest of the
 * attribute into one declaration.
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
 * A declaration cannot be read in isolation: the cascade lets a later one win,
 * so `display:none;display:block` renders. `!important` inverts that for a
 * later *normal* declaration but not for a later important one.
 *
 * Mirrored by `hasHidingDeclaration` in src/highlights/sentenceHighlight.js;
 * the two must agree exactly on which text survives.
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
    // A normal declaration never overrides an important one, whatever the order.
    if (previous && previous.important && !important) continue;
    winners.set(property, { value, important });
  }
  for (const [property, hidingValue] of HIDING_VALUES) {
    if (winners.get(property)?.value === hidingValue) return true;
  }
  return false;
}

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
  return hasHidingDeclaration(attributes.get('style') || '');
}

/**
 * Offset just past the end tag closing a raw-text or RCDATA element.
 *
 * Their content is text, not markup, so the *first* end tag closes them and a
 * same-name start tag inside does not nest. Depth counting here would run past
 * `</script>` on ordinary code such as `var s = "<script>"`, swallowing the rest
 * of the document — `stripTagsKeepOffsets`' own block scanner has always used
 * these first-end-tag semantics.
 * @param {string} html Original HTML.
 * @param {string} name Lower-cased tag name, from a fixed set.
 * @param {number} from Offset just past the opening tag.
 * @returns {number} `html.length` when the element is never closed, the same
 *   lenient choice `findElementEnd` makes.
 */
function findRawTextEnd(html, name, from) {
  const endTag = new RegExp(`</${name}(?=[\\s/>]|$)`, 'ig');
  endTag.lastIndex = from;
  const match = endTag.exec(html);
  if (!match) return html.length;
  const gt = html.indexOf('>', match.index);
  return gt < 0 ? html.length : gt + 1;
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
      i = findRawTextEnd(html, tag.name, tag.end);
      continue;
    }
    i = tag.end;
  }
  return { closeStart: html.length, end: html.length };
}

/**
 * Locate the `<summary>` a closed `<details>` still renders: its first *direct*
 * `<summary>` child. A `<summary>` nested inside another element (or inside a
 * nested `<details>`) is not the widget's summary and stays hidden.
 * @param {string} html Original HTML.
 * @param {number} from Offset just past the `<details>` opening tag.
 * @param {number} until Offset of the matching `</details>`.
 * @returns {?{start: number, end: number}}
 */
function findSummaryRange(html, from, until) {
  // Element nesting depth below the <details>; a direct child sits at 0.
  let depth = 0;
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
    // Raw-text and RCDATA content is text, not markup. A `<` inside script or
    // textarea text would otherwise parse as a tag and inflate the depth,
    // hiding the real direct <summary> — the DOM walk in sentenceHighlight.js
    // still sees it, and the two must agree on which text survives.
    if (
      !tag.closing &&
      !tag.selfClosing &&
      (RAW_TEXT_TAGS.has(tag.name) || RCDATA_TAGS.has(tag.name))
    ) {
      i = Math.min(findRawTextEnd(html, tag.name, tag.end), until);
      continue;
    }
    if (tag.name === 'summary' && !tag.closing && depth === 0) {
      const { end } = findElementEnd(html, 'summary', tag.end);
      return { start: lt, end: Math.min(end, until) };
    }
    if (!VOID_TAGS.has(tag.name) && !tag.selfClosing) {
      // Clamp at 0 so unbalanced markup (a stray `</p>`) cannot drive the depth
      // negative and make a genuinely nested <summary> look like a direct child.
      depth = tag.closing ? Math.max(0, depth - 1) : depth + 1;
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
      i = findRawTextEnd(html, tag.name, tag.end);
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

/**
 * Apply the shared post-scan filtering and normalization to text and its
 * source-offset mapping. Both the legacy HTML scanner and the v2 plain-text
 * scanner build the same intermediate arrays, so keeping this work here
 * prevents their Unicode, zero-width, whitespace, and sentinel behavior from
 * drifting apart.
 *
 * @param {string[]} out Text code units collected by a scanner.
 * @param {number[]} mapping Source offset for each collected code unit.
 * @param {number} sourceLength Length of the scanner's source string.
 * @returns {{text: string, mapping: number[]}}
 */
function finalizeStrippedText(out, mapping, sourceLength) {
  // Keep this filtering in lockstep for all text extraction paths. Unicode
  // Tags characters are an invisible prompt-injection channel, except when
  // they form a valid subdivision-flag sequence.
  const flagFilteredOut = [];
  const flagFilteredMapping = [];
  let inFlagContext = false;
  for (let i = 0; i < out.length; ) {
    const cu = out[i].charCodeAt(0);
    let cp = cu;
    let unitLen = 1;
    if (cu >= 0xd800 && cu <= 0xdbff && i + 1 < out.length) {
      const lo = out[i + 1].charCodeAt(0);
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
      flagFilteredOut.push(out[i]);
      flagFilteredMapping.push(mapping[i]);
      if (unitLen === 2) {
        flagFilteredOut.push(out[i + 1]);
        flagFilteredMapping.push(mapping[i + 1]);
      }
    }
    i += unitLen;
  }

  // Strip suspicious runs of zero-width formatting characters, preserving
  // short runs used by legitimate scripts/emoji shaping.
  const targetChars = new Set(['\u200b', '\u200c', '\u200d', '\ufeff']);
  const filteredOut = [];
  const filteredMapping = [];
  for (let i = 0; i < flagFilteredOut.length; ) {
    if (!targetChars.has(flagFilteredOut[i])) {
      filteredOut.push(flagFilteredOut[i]);
      filteredMapping.push(flagFilteredMapping[i]);
      i += 1;
      continue;
    }
    let end = i + 1;
    while (end < flagFilteredOut.length && targetChars.has(flagFilteredOut[end])) end += 1;
    if (end - i < 4) {
      for (let k = i; k < end; k += 1) {
        filteredOut.push(flagFilteredOut[k]);
        filteredMapping.push(flagFilteredMapping[k]);
      }
    }
    i = end;
  }

  // Collapse consecutive spaces that might have been left adjacent after
  // stripping.
  const collapsedOut = [];
  const collapsedMapping = [];
  let lastWasSpace = true; // suppress revealed leading whitespace
  for (let i = 0; i < filteredOut.length; i += 1) {
    if (filteredOut[i] === ' ') {
      if (lastWasSpace) continue;
      collapsedOut.push(' ');
      collapsedMapping.push(filteredMapping[i]);
      lastWasSpace = true;
    } else {
      collapsedOut.push(filteredOut[i]);
      collapsedMapping.push(filteredMapping[i]);
      lastWasSpace = false;
    }
  }
  while (collapsedOut.length > 0 && collapsedOut[collapsedOut.length - 1] === ' ') {
    collapsedOut.pop();
    collapsedMapping.pop();
  }
  collapsedMapping.push(sourceLength);
  return { text: collapsedOut.join(''), mapping: collapsedMapping };
}

/**
 * Normalize text captured from the live DOM while preserving its literal
 * characters. Unlike `stripTagsKeepOffsets`, this function deliberately does
 * not interpret `<`, `>` or `&` as markup/entity syntax: those characters are
 * already text by the time the browser exposes `Text#nodeValue`.
 *
 * The returned mapping uses UTF-16 offsets into the input string, matching the
 * mapping contract of `stripTagsKeepOffsets`. For capture-version 2 records,
 * downstream range offsets are therefore relative to `capturedText`; legacy
 * records continue to produce HTML-relative offsets.
 *
 * @param {string} input Plain text extracted in the page context.
 * @returns {{text: string, mapping: number[]}}
 */
export function normalizePlainTextKeepOffsets(input) {
  const plain = String(input ?? '');
  const out = [];
  const mapping = [];
  let lastWasSpace = true;
  const pushChar = (ch, origPos) => {
    if (isWhitespace(ch)) {
      if (lastWasSpace) return;
      out.push(' ');
      mapping.push(origPos);
      lastWasSpace = true;
    } else if (isStrippableFormatChar(ch)) {
      return;
    } else {
      // In particular, do not decode entities here. A literal `&lt;` in a
      // Text node is four visible characters and must stay four characters.
      out.push(ch);
      mapping.push(origPos);
      lastWasSpace = false;
    }
  };
  for (let i = 0; i < plain.length; i += 1) pushChar(plain[i], i);
  return finalizeStrippedText(out, mapping, plain.length);
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

  return finalizeStrippedText(out, mapping, n);
}
