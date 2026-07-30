// HTML cleaning with offset mapping back to the original HTML string.
// Single linear pass: strips <script>/<style> blocks, removes other tags,
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

export function stripTagsKeepOffsets(html) {
  const out = [];
  const mapping = [];
  let lastWasSpace = true; // suppress leading whitespace
  let i = 0;
  const n = html.length;

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
        const restLower = html.toLowerCase();
        const closeIdx = restLower.indexOf(closing, tagEnd + 1);
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
