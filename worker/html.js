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

function isWhitespace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v';
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

  // Trim trailing whitespace.
  while (out.length > 0 && out[out.length - 1] === ' ') {
    out.pop();
    mapping.pop();
  }
  // Sentinel for end offset.
  mapping.push(n);
  return { text: out.join(''), mapping };
}
