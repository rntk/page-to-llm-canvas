// Unicode-aware text projection shared by worker extraction and DOM highlighting.
// Offsets are JavaScript UTF-16 code-unit offsets. `mapping[i]` points at the
// source offset for projected code unit i; the final entry is always text.length.

export const DEFAULT_MAX_GRAPHEME_CODE_UNITS = 256;
export const DEFAULT_MAX_COMPLEX_CODE_UNITS = 4096;

const DEFAULT_IGNORABLE_RE = /\p{Default_Ignorable_Code_Point}/u;
const CONTROL_RE = /\p{Control}/u;
const MARK_RE = /\p{Mark}/u;
const GRAPHEME_EXTEND_RE = /\p{Grapheme_Extend}/u;
const JOIN_CONTROL_RE = /\p{Join_Control}/u;
const JS_WHITESPACE_RE = /\s/u;

const defaultSegmenter =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter('und', { granularity: 'grapheme' })
    : null;

function isWhitespaceCodePoint(codePoint) {
  return JS_WHITESPACE_RE.test(codePoint);
}

function isBoundaryJunk(codePoint) {
  return (
    DEFAULT_IGNORABLE_RE.test(codePoint) ||
    (CONTROL_RE.test(codePoint) && !isWhitespaceCodePoint(codePoint))
  );
}

function isComplex(codePoint) {
  return isBoundaryJunk(codePoint) || MARK_RE.test(codePoint);
}

function isFallbackConnector(codePoint) {
  return GRAPHEME_EXTEND_RE.test(codePoint) || JOIN_CONTROL_RE.test(codePoint);
}

// A property-driven approximation used only when Intl.Segmenter is missing.
// It attaches grapheme extenders to their base and follows Join_Control across
// the next base, preserving the common shaping/emoji cases without maintaining
// sequence-specific tables. It is deliberately not a complete UAX #29
// implementation (for example, regional-indicator pairing and Hangul syllable
// rules remain separate segments); projection still preserves their code points.
function* fallbackSegments(text) {
  let index = 0;
  while (index < text.length) {
    const codePoint = String.fromCodePoint(text.codePointAt(index));
    if (isWhitespaceCodePoint(codePoint) || isComplex(codePoint)) {
      yield { segment: codePoint, index };
      index += codePoint.length;
      continue;
    }

    const start = index;
    index += codePoint.length;
    let joinsNextBase = false;
    while (index < text.length) {
      const next = String.fromCodePoint(text.codePointAt(index));
      if (isFallbackConnector(next)) {
        joinsNextBase ||= JOIN_CONTROL_RE.test(next);
        index += next.length;
      } else if (joinsNextBase && !isWhitespaceCodePoint(next) && !isComplex(next)) {
        index += next.length;
        joinsNextBase = false;
      } else {
        break;
      }
    }
    yield { segment: text.slice(start, index), index: start };
  }
}

/**
 * Iterate UTF-16-indexed grapheme segments using Intl when available and the
 * same property-driven semantic fallback used by projectText otherwise.
 */
export function* iterateGraphemes(value, { segmenter = defaultSegmenter } = {}) {
  const text = String(value ?? '');
  const segments =
    segmenter && typeof segmenter.segment === 'function'
      ? segmenter.segment(text)
      : fallbackSegments(text);
  for (const { segment, index } of segments) yield { segment, index };
}

function classifyCluster(cluster) {
  let junkCodePoints = 0;
  let whitespaceCodePoints = 0;
  let visibleCodePoints = 0;
  let trailingJunkStart = -1;
  let codeUnitOffset = 0;

  for (const codePoint of cluster) {
    const whitespace = isWhitespaceCodePoint(codePoint);
    const complex = isComplex(codePoint);
    if (whitespace) whitespaceCodePoints++;
    if (complex) {
      junkCodePoints++;
      if (isBoundaryJunk(codePoint)) {
        if (trailingJunkStart < 0) trailingJunkStart = codeUnitOffset;
      } else {
        trailingJunkStart = -1;
      }
    } else if (!whitespace) {
      visibleCodePoints++;
      trailingJunkStart = -1;
    } else {
      trailingJunkStart = -1;
    }
    codeUnitOffset += codePoint.length;
  }

  return { junkCodePoints, whitespaceCodePoints, visibleCodePoints, trailingJunkStart };
}

/**
 * Project arbitrary Unicode text into bounded model-safe text.
 *
 * Complete visible grapheme clusters are retained verbatim, which preserves
 * shaping and emoji sequences without maintaining character allowlists.
 * Whitespace is normalized to one ASCII space. Runs containing only Unicode
 * default-ignorables/control characters are removed when isolated and become a
 * boundary when repeated. A pathologically large grapheme is also replaced by
 * a boundary. A document-wide complexity budget bounds cumulative marks,
 * controls, and default-ignorables across otherwise valid short graphemes;
 * after the budget, their visible bases remain while complex units are dropped.
 *
 * Pass `segmenter: null` to exercise the deterministic property-driven fallback
 * used by runtimes without Intl.Segmenter. It never splits surrogate pairs.
 */
export function projectText(
  value,
  {
    maxGraphemeCodeUnits = DEFAULT_MAX_GRAPHEME_CODE_UNITS,
    maxComplexCodeUnits = DEFAULT_MAX_COMPLEX_CODE_UNITS,
    segmenter = defaultSegmenter,
  } = {},
) {
  const text = String(value ?? '');
  if (!Number.isInteger(maxGraphemeCodeUnits) || maxGraphemeCodeUnits < 1) {
    throw new RangeError('maxGraphemeCodeUnits must be a positive integer');
  }
  if (!Number.isInteger(maxComplexCodeUnits) || maxComplexCodeUnits < 0) {
    throw new RangeError('maxComplexCodeUnits must be a non-negative integer');
  }

  const out = [];
  const mapping = [];
  const spans = [];
  let pendingJunkStart = -1;
  let pendingJunkEnd = -1;
  let pendingJunkCodePoints = 0;
  let complexCodeUnitsUsed = 0;
  let lastWasSpace = true;

  const emitSpace = (sourceStart, sourceEnd) => {
    if (lastWasSpace) {
      if (out[out.length - 1] === ' ') spans[spans.length - 1].end = sourceEnd;
      return;
    }
    out.push(' ');
    mapping.push(sourceStart);
    spans.push({ start: sourceStart, end: sourceEnd });
    lastWasSpace = true;
  };

  const flushJunk = () => {
    if (pendingJunkCodePoints >= 2) emitSpace(pendingJunkStart, pendingJunkEnd);
    pendingJunkStart = -1;
    pendingJunkEnd = -1;
    pendingJunkCodePoints = 0;
  };

  const appendJunk = (start, end, codePoints) => {
    if (pendingJunkStart < 0) pendingJunkStart = start;
    pendingJunkEnd = end;
    pendingJunkCodePoints += codePoints;
  };

  const appendVisible = (segment, index) => {
    if (segment.length > maxGraphemeCodeUnits) {
      emitSpace(index, index + segment.length);
      return;
    }
    let unit = 0;
    while (unit < segment.length) {
      const codePoint = String.fromCodePoint(segment.codePointAt(unit));
      const complex = isComplex(codePoint);
      const preserve = !complex || complexCodeUnitsUsed + codePoint.length <= maxComplexCodeUnits;
      if (preserve) {
        for (let codeUnit = 0; codeUnit < codePoint.length; codeUnit++) {
          out.push(codePoint[codeUnit]);
          mapping.push(index + unit + codeUnit);
          spans.push({
            start: index + unit + codeUnit,
            end: index + unit + codeUnit + 1,
          });
        }
        if (complex) complexCodeUnitsUsed += codePoint.length;
      }
      unit += codePoint.length;
    }
    lastWasSpace = false;
  };

  const iterator = iterateGraphemes(text, { segmenter });
  let current = iterator.next();
  let classification = current.done ? null : classifyCluster(current.value.segment);

  while (!current.done) {
    const { segment, index } = current.value;
    const { junkCodePoints, whitespaceCodePoints, visibleCodePoints, trailingJunkStart } =
      classification;
    const next = iterator.next();
    const nextClassification = next.done ? null : classifyCluster(next.value.segment);

    if (visibleCodePoints > 0) {
      flushJunk();
      const nextIsJunkOnly =
        nextClassification &&
        nextClassification.visibleCodePoints === 0 &&
        nextClassification.junkCodePoints > 0;
      if (trailingJunkStart > 0 && nextIsJunkOnly) {
        appendVisible(segment.slice(0, trailingJunkStart), index);
        const suffix = segment.slice(trailingJunkStart);
        appendJunk(index + trailingJunkStart, index + segment.length, Array.from(suffix).length);
      } else {
        appendVisible(segment, index);
      }
    } else if (whitespaceCodePoints > 0) {
      flushJunk();
      emitSpace(index, index + segment.length);
    } else if (junkCodePoints > 0) {
      appendJunk(index, index + segment.length, junkCodePoints);
    }

    current = next;
    classification = nextClassification;
  }

  flushJunk();
  if (lastWasSpace && out.length > 0) {
    out.pop();
    mapping.pop();
    spans.pop();
  }
  mapping.push(text.length);
  return { text: out.join(''), mapping, spans };
}
