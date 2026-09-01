// Normalization for text captured from the live DOM. The browser-side capture
// has already resolved markup, entities, CSS, and layout visibility, so this
// module must treat every input character as literal text.

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

function filterUnicodeTags(out) {
  const filteredOut = [];
  let inFlagContext = false;
  const pendingTagOut = [];

  function flushPendingTags() {
    for (let k = 0; k < pendingTagOut.length; k += 1) {
      filteredOut.push(pendingTagOut[k]);
    }
    pendingTagOut.length = 0;
  }

  function discardPendingTags() {
    pendingTagOut.length = 0;
  }

  for (let i = 0; i < out.length; ) {
    const high = out[i].charCodeAt(0);
    let codePoint = high;
    let unitLength = 1;
    if (high >= 0xd800 && high <= 0xdbff && i + 1 < out.length) {
      const low = out[i + 1].charCodeAt(0);
      if (low >= 0xdc00 && low <= 0xdfff) {
        codePoint = (high - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000;
        unitLength = 2;
      }
    }

    const isTag = codePoint >= 0xe0000 && codePoint <= 0xe007f;

    if (codePoint === 0x1f3f4) {
      // Discard any prior unterminated tag run before starting a new flag.
      discardPendingTags();
      inFlagContext = true;
      for (let offset = 0; offset < unitLength; offset += 1) {
        filteredOut.push(out[i + offset]);
      }
    } else if (isTag) {
      if (inFlagContext) {
        for (let offset = 0; offset < unitLength; offset += 1) {
          pendingTagOut.push(out[i + offset]);
        }
        if (codePoint === 0xe007f) {
          flushPendingTags();
          inFlagContext = false;
        }
      } else {
        // Tag outside a flag context is stripped.
      }
    } else {
      // Non-tag, non-flag: any pending unterminated tag run is invalid and discarded.
      discardPendingTags();
      inFlagContext = false;
      for (let offset = 0; offset < unitLength; offset += 1) {
        filteredOut.push(out[i + offset]);
      }
    }
    i += unitLength;
  }
  // Trailing tags without a terminator are discarded (buffer not flushed).
  return filteredOut;
}

function finalizeCapturedText(out) {
  const tagFiltered = filterUnicodeTags(out);
  const filteredOut = [];
  const zeroWidthChars = new Set(['\u200b', '\u200c', '\u200d', '\ufeff']);

  for (let i = 0; i < tagFiltered.length; ) {
    if (!zeroWidthChars.has(tagFiltered[i])) {
      filteredOut.push(tagFiltered[i]);
      i += 1;
      continue;
    }
    let end = i + 1;
    while (end < tagFiltered.length && zeroWidthChars.has(tagFiltered[end])) end += 1;
    if (end - i < 4) {
      for (let offset = i; offset < end; offset += 1) {
        filteredOut.push(tagFiltered[offset]);
      }
    }
    i = end;
  }

  const collapsedOut = [];
  let lastWasSpace = true;
  for (let i = 0; i < filteredOut.length; i += 1) {
    if (filteredOut[i] === ' ') {
      if (lastWasSpace) continue;
      lastWasSpace = true;
    } else {
      lastWasSpace = false;
    }
    collapsedOut.push(filteredOut[i]);
  }
  if (collapsedOut.at(-1) === ' ') {
    collapsedOut.pop();
  }
  return collapsedOut.join('');
}

/**
 * Normalize browser-captured plain text.
 * Literal markup-looking and entity-looking characters are not interpreted.
 * @param {string} input Text extracted in the page context.
 * @returns {string}
 */
export function normalizeCapturedText(input) {
  const plain = String(input ?? '');
  const out = [];
  let lastWasSpace = true;

  for (let i = 0; i < plain.length; i += 1) {
    const ch = plain[i];
    if (isWhitespace(ch)) {
      if (lastWasSpace) continue;
      out.push(' ');
      lastWasSpace = true;
    } else if (!isStrippableFormatChar(ch)) {
      out.push(ch);
      lastWasSpace = false;
    }
  }
  return finalizeCapturedText(out);
}
