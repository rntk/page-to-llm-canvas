const NAMED_ENTITIES = Object.assign(Object.create(null), {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
});

// HTML parsers map these historical Windows-1252 numeric references instead
// of emitting the corresponding C1 control characters.
const WINDOWS_1252_REPLACEMENTS = {
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

function decodeEntityAt(text, index) {
  if (text[index] !== '&') return null;
  const semicolon = text.indexOf(';', index + 1);
  if (semicolon < 0 || semicolon - index > 10) return null;
  const body = text.slice(index + 1, semicolon);
  if (!body) return null;

  if (body[0] === '#') {
    const code =
      body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
    if (!Number.isFinite(code) || code <= 0) return null;
    try {
      return [String.fromCodePoint(WINDOWS_1252_REPLACEMENTS[code] ?? code), semicolon - index + 1];
    } catch {
      return null;
    }
  }

    const key = body.toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, key)) return null;
  const decoded = NAMED_ENTITIES[key];
  return [decoded, semicolon - index + 1];
}

/**
 * Decode the small HTML-entity set accepted in model-produced topic labels.
 * @param {string} value Model-produced label text.
 * @returns {string} Decoded label text.
 */
export function decodeEntities(value) {
  const text = String(value ?? '');
  if (!text.includes('&')) return text;
  let output = '';
  for (let i = 0; i < text.length; ) {
    const decoded = decodeEntityAt(text, i);
    if (decoded) {
      output += decoded[0];
      i += decoded[1];
    } else {
      output += text[i];
      i += 1;
    }
  }
  return output;
}
