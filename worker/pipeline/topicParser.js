// Port of txt_splitt/sentences/parsers.py TopicRangeParser (text mode only) +
// RepairingGapHandler (deterministic coverage repair) + AdjacentSameTopicJoiner.
//
// Robustness contract (matches the Python txt_splitt library, not split_text.py's
// specific handler choice): the parser is permissive — it CLAMPS ranges to
// [0, sentenceCount-1] and never rejects the response for duplicate, missing, or
// out-of-range markers. A separate deterministic repair step then trims overlaps
// (first-claim-wins) and fills gaps by extending adjacent ranges, guaranteeing
// continuous [0, sentenceCount-1] coverage without any extra LLM calls. The only
// remaining hard failure is a response with no parseable topic ranges at all,
// which still raises TopicParseError so the orchestrator can retry.

import { decodeEntities } from './html.js';

const TOPIC_LINE_RE = /^(.+):\s*(\d[\d\s,-]*)\s*$/;
const RANGE_TOKEN_RE = /^(\d+)\s*-\s*(\d+)$/;
const SINGLE_TOKEN_RE = /^(\d+)$/;

/** Thrown when the LLM response contains no parseable topic ranges at all. */
export class TopicParseError extends Error {
  /**
   * @param {string} message
   * @param {object} diagnostics
   * @param {Array<number[]>} [diagnostics.outOfRange]
   * @param {number[]} [diagnostics.duplicates]
   * @param {number[]} [diagnostics.missing]
   * @param {number} [diagnostics.invalidRangeTokens]
   * @param {string[]} [diagnostics.ignoredLineSamples]
   * @param {Array<object>} [diagnostics.repairs]
   * @param {boolean} [diagnostics.repairsTruncated]
   */
  constructor(message, diagnostics = {}) {
    super(message);
    this.name = 'TopicParseError';
    this.diagnostics = diagnostics;
  }
}

/**
 * Canonicalizes one label segment for storage/display: decodes HTML entities
 * the LLM may echo (e.g. "Claude&nbsp;Tag"), then collapses every Unicode
 * whitespace run (NBSP included) to a single space and trims. Without this,
 * "Claude&nbsp;Tag" / "Claude  Tag" / "Claude   Tag" persist as distinct tree
 * branches even though the dedup key would treat them as equal.
 * @param {string} raw Raw label segment.
 */
function normalizeSegment(raw) {
  return decodeEntities(raw).replace(/\s+/gu, ' ').trim();
}

function normalizeLabelParts(parts) {
  const out = [];
  for (const raw of parts) {
    const part = normalizeSegment(raw);
    if (!part) continue;
    // Entity decoding can introduce hierarchy delimiters after the raw topic
    // path was split (for example, `A&gt;B`). Canonicalize both delimiters here
    // so encoded and literal paths cannot serialize to the same topic name
    // while retaining different deduplication keys.
    for (const sub of part.split(/[:>]/u)) {
      const s = sub.trim();
      if (s) out.push(s);
    }
  }
  return out;
}

function normalizeLabelKey(label) {
  return label
    .map((p) => p.normalize('NFKC').trim().toLocaleLowerCase().replace(/\s+/gu, ' '))
    .join('|');
}

function parseRangeString(str) {
  const results = [];
  let invalidCount = 0;
  for (const partRaw of str.split(',')) {
    const part = partRaw.trim();
    if (!part) continue;
    const rangeMatch = RANGE_TOKEN_RE.exec(part);
    if (rangeMatch) {
      results.push([parseInt(rangeMatch[1], 10), parseInt(rangeMatch[2], 10)]);
      continue;
    }
    const singleMatch = SINGLE_TOKEN_RE.exec(part);
    if (singleMatch) {
      const n = parseInt(singleMatch[1], 10);
      results.push([n, n]);
      continue;
    }
    invalidCount++;
  }
  return { ranges: results, invalidCount };
}

/**
 * Clamp a (start, end) pair into [0, maxIndex], swapping if reversed.
 * Port of parsers.py _clamp_range. Returns null when maxIndex < 0.
 *
 * @param {number} start
 * @param {number} end
 * @param {number} maxIndex
 * @returns {{start: number, end: number} | null}
 */
function clampRange(start, end, maxIndex) {
  if (maxIndex < 0) return null;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  start = Math.max(0, Math.min(start, maxIndex));
  end = Math.max(0, Math.min(end, maxIndex));
  if (start > end) {
    const tmp = start;
    start = end;
    end = tmp;
  }
  return { start, end };
}

const MAX_IGNORED_LINE_SAMPLES = 10;
const IGNORED_LINE_SAMPLE_MAX_CHARS = 200;
const MAX_REPAIRS = 50;

/** Truncate a raw line to a safe sample length (privacy-safe: caller-gated by verbose logging).
 * @param {string} line Raw parser line.
 */
function truncateSample(line) {
  return line.length > IGNORED_LINE_SAMPLE_MAX_CHARS
    ? line.slice(0, IGNORED_LINE_SAMPLE_MAX_CHARS)
    : line;
}

function mergeRanges(ranges) {
  if (!ranges.length) return [];
  const ordered = ranges.slice().sort((a, b) => a.start - b.start || a.end - b.end);
  const out = [{ ...ordered[0] }];
  for (let i = 1; i < ordered.length; i++) {
    const cur = ordered[i];
    const last = out[out.length - 1];
    if (cur.start <= last.end + 1) {
      last.end = Math.max(last.end, cur.end);
    } else {
      out.push({ ...cur });
    }
  }
  return out;
}

/**
 * Repair group coverage so every index in [0, sentenceCount-1] is covered
 * exactly once. Port of gap_handlers.py RepairingGapHandler.handle (the
 * deterministic, no-LLM variant):
 *   - Sorts all ranges by start; later overlapping ranges are trimmed so the
 *     earliest-starting range keeps the contested indices (first-claim-wins).
 *   - Fills gaps by extending an adjacent range: a gap at the very beginning
 *     pulls the first range's start back to 0; a gap in the middle extends the
 *     previously-added range forward; a trailing gap extends the last range.
 *
 * @param {Array<{label: string[], ranges: Array<{start: number, end: number}>}>} groups
 * @param {number} sentenceCount
 * @param {Array<object>} repairs Output array; each deterministic fix is pushed here
 *   (capped by the caller via pushRepair), so callers can surface WHY coverage
 *   needed repair without re-deriving it from the before/after groups.
 * @returns {Array<{label: string[], ranges: Array<{start: number, end: number}>}>}
 */
function repairCoverage(groups, sentenceCount, repairs) {
  const maxIndex = sentenceCount - 1;

  // Flatten all (groupIndex, range) pairs and sort by start, then parse order.
  const flat = [];
  groups.forEach((g, gi) => {
    for (const r of g.ranges) flat.push({ gi, range: r });
  });
  flat.sort((a, b) => a.range.start - b.range.start || a.range.ordinal - b.range.ordinal);

  const adjusted = groups.map(() => []);
  let nextExpected = 0;
  let lastAdded = null; // { gi, idx } of the most recently appended range

  for (const { gi, range } of flat) {
    if (range.end < nextExpected) {
      // Entirely consumed by an earlier range (overlap) — drop it.
      pushRepair(repairs, { type: 'overlap-drop', start: range.start, end: range.end });
      continue;
    }
    let start = Math.max(range.start, nextExpected);
    if (start > range.end) continue;
    if (start !== range.start) {
      pushRepair(repairs, {
        type: 'overlap-trim',
        start: range.start,
        end: range.end,
        newStart: start,
      });
    }

    if (start > nextExpected) {
      // Gap before this range.
      if (lastAdded === null) {
        // Gap at the very beginning: pull this first range back to 0.
        pushRepair(repairs, { type: 'gap-start', filledStart: 0, filledEnd: start - 1 });
        start = 0;
      } else {
        // Gap in the middle: extend the previously-added range forward.
        const prev = adjusted[lastAdded.gi][lastAdded.idx];
        pushRepair(repairs, {
          type: 'gap-middle',
          filledStart: prev.end + 1,
          filledEnd: start - 1,
        });
        adjusted[lastAdded.gi][lastAdded.idx] = { start: prev.start, end: start - 1 };
      }
    }

    adjusted[gi].push({ start, end: range.end });
    lastAdded = { gi, idx: adjusted[gi].length - 1 };
    nextExpected = range.end + 1;
  }

  // Trailing gap: extend the last added range to the final index.
  if (nextExpected <= maxIndex && lastAdded !== null) {
    const prev = adjusted[lastAdded.gi][lastAdded.idx];
    pushRepair(repairs, { type: 'gap-tail', filledStart: nextExpected, filledEnd: maxIndex });
    adjusted[lastAdded.gi][lastAdded.idx] = { start: prev.start, end: maxIndex };
  }

  // Rebuild groups in original order, dropping any that lost all ranges.
  const result = [];
  groups.forEach((g, gi) => {
    if (adjusted[gi].length) result.push({ label: g.label, ranges: adjusted[gi] });
  });
  return result;
}

/** Push a repair entry, capping the array at MAX_REPAIRS and tracking truncation via `.truncated`.
 * @param {Array<object>} repairs Mutable repair list.
 * @param {object} entry Repair entry.
 */
function pushRepair(repairs, entry) {
  if (!repairs) return;
  if (repairs.length >= MAX_REPAIRS) {
    repairs.truncated = true;
    return;
  }
  repairs.push(entry);
}

function collectDiagnostics(rawGroups, sentenceCount, invalidRangeTokens = 0) {
  const seen = new Array(sentenceCount).fill(0);
  const outOfRange = [];

  for (const g of rawGroups) {
    for (const r of g.ranges) {
      if (
        r.rawStart < 0 ||
        r.rawEnd < 0 ||
        r.rawStart >= sentenceCount ||
        r.rawEnd >= sentenceCount
      ) {
        outOfRange.push([r.rawStart, r.rawEnd]);
      }
      for (let i = r.start; i <= r.end; i++) seen[i]++;
    }
  }

  const duplicates = [];
  const missing = [];
  for (let i = 0; i < seen.length; i++) {
    if (seen[i] > 1) duplicates.push(i);
    if (seen[i] === 0) missing.push(i);
  }

  return { outOfRange, duplicates, missing, invalidRangeTokens };
}

/**
 * Shared tail of parseTopicRanges: takes label-grouped ranges (in first-appearance
 * order, labels already deduped) and produces the final continuous, non-overlapping,
 * adjacent-joined groups. Extracted so oversized-range refinement can rebuild the
 * same shape from re-split segments without re-parsing a raw LLM response.
 *
 * @param {Array<{label: string[], ranges: Array<{start: number, end: number}>}>} rawGroups
 * @param {number} sentenceCount
 * @param invalidRangeTokens
 * @returns {Array<{label: string[], ranges: Array<{start: number, end: number}>}>}
 */
function finalizeGroups(rawGroups, sentenceCount, invalidRangeTokens = 0) {
  let groups = [];
  for (const g of rawGroups) {
    const merged = mergeRanges(g.ranges);
    if (!merged.length) continue;
    groups.push({ label: g.label, ranges: merged });
  }
  const diagnostics = collectDiagnostics(rawGroups, sentenceCount, invalidRangeTokens);
  if (!groups.length) {
    // No ranges survived to repair — report an empty, untruncated repair list
    // rather than omitting the fields on this error path.
    diagnostics.repairs = [];
    diagnostics.repairsTruncated = false;
    throw new TopicParseError('No valid topic ranges found in response', diagnostics);
  }

  // Repair overlaps and gaps so coverage is continuous over [0, maxIndex]. The
  // `repairs` array (capped at MAX_REPAIRS, with `.truncated` set past the cap)
  // records what was fixed and why, for verbose diagnostics upstream.
  const repairs = [];
  groups = repairCoverage(groups, sentenceCount, repairs);
  diagnostics.repairs = repairs.slice(0, MAX_REPAIRS);
  diagnostics.repairsTruncated = Boolean(repairs.truncated);

  // AdjacentSameTopicJoiner: merge consecutive groups with identical labels.
  const joined = [];
  for (const g of groups) {
    const last = joined[joined.length - 1];
    if (
      last &&
      last.label.length === g.label.length &&
      last.label.every((p, i) => p === g.label[i])
    ) {
      last.ranges = mergeRanges(last.ranges.concat(g.ranges));
    } else {
      joined.push({ label: g.label.slice(), ranges: g.ranges.slice() });
    }
  }
  return { groups: joined, diagnostics };
}

/**
 * Rebuild final groups from a flat list of labeled segments (e.g. produced by
 * re-splitting an oversized range). Segments sharing a normalized label key are
 * merged into one group — preserving the invariant that every topic name is
 * unique — and coverage is repaired/joined exactly like parseTopicRanges.
 *
 * @param {Array<{label: string[], start: number, end: number}>} segments
 * @param {number} sentenceCount
 * @returns {Array<{label: string[], ranges: Array<{start: number, end: number}>}>}
 */
export function groupsFromSegments(segments, sentenceCount) {
  if (sentenceCount <= 0) throw new Error('sentenceCount must be positive');
  const maxIndex = sentenceCount - 1;

  const grouped = new Map();
  const order = [];
  const keyToCanonical = new Map();
  let ordinal = 0;
  for (const seg of segments) {
    if (!seg.label || !seg.label.length) continue;
    const key = normalizeLabelKey(seg.label);
    if (!keyToCanonical.has(key)) keyToCanonical.set(key, seg.label);
    const label = keyToCanonical.get(key);
    const range = clampRange(seg.start, seg.end, maxIndex);
    if (range === null) continue;
    if (!grouped.has(key)) {
      grouped.set(key, { label, ranges: [] });
      order.push(key);
    }
    grouped.get(key).ranges.push({
      ...range,
      rawStart: seg.start,
      rawEnd: seg.end,
      ordinal: ordinal++,
    });
  }
  const rawGroups = order.map((k) => grouped.get(k));
  return finalizeGroups(rawGroups, sentenceCount).groups;
}

// Returns Array<{ label: string[], ranges: Array<{start, end}> }> (inclusive 0-based).
export function parseTopicRanges(response, sentenceCount) {
  return parseTopicRangesDetailed(response, sentenceCount).groups;
}

/**
 * Parse topic ranges and expose privacy-safe quality diagnostics describing any
 * deterministic repair the permissive parser had to perform.
 * @param {string} response Raw model response.
 * @param {number} sentenceCount Number of article sentences.
 */
export function parseTopicRangesDetailed(response, sentenceCount) {
  if (sentenceCount <= 0) throw new Error('sentenceCount must be positive');
  const maxIndex = sentenceCount - 1;
  const lines = response
    .trim()
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const grouped = new Map(); // key -> { label, ranges[] }
  const order = [];
  const keyToCanonical = new Map();
  let ordinal = 0;
  let invalidRangeTokens = 0;
  let reversedRanges = 0;
  let parsedLineCount = 0;
  // Raw lines the parse loop skipped (no `:`, empty topic path, empty label, or
  // zero clamped ranges), sampled for verbose diagnostics — never fed into
  // recordParserMetric, which must stay privacy-safe.
  const ignoredLineSamples = [];
  const recordIgnoredLine = (ln) => {
    if (ignoredLineSamples.length < MAX_IGNORED_LINE_SAMPLES) {
      ignoredLineSamples.push(truncateSample(ln));
    }
  };

  for (const ln of lines) {
    let topicPath, rangesStr;
    const m = TOPIC_LINE_RE.exec(ln);
    if (m) {
      topicPath = m[1].trim();
      rangesStr = m[2].trim();
    } else if (ln.includes(':')) {
      const idx = ln.indexOf(':');
      topicPath = ln.slice(0, idx).trim();
      rangesStr = ln.slice(idx + 1).trim();
    } else {
      recordIgnoredLine(ln);
      continue;
    }
    if (!topicPath) {
      recordIgnoredLine(ln);
      continue;
    }

    let label = normalizeLabelParts(topicPath.split('>'));
    if (!label.length) {
      recordIgnoredLine(ln);
      continue;
    }
    const key = normalizeLabelKey(label);
    if (!keyToCanonical.has(key)) keyToCanonical.set(key, label);
    label = keyToCanonical.get(key);

    const parsed = parseRangeString(rangesStr);
    invalidRangeTokens += parsed.invalidCount;
    const clamped = [];
    for (const [s, e] of parsed.ranges) {
      if (s > e) reversedRanges++;
      // Clamp to bounds (matches Python TopicRangeParser); never reject.
      const r = clampRange(s, e, maxIndex);
      if (r !== null) {
        clamped.push({ ...r, rawStart: s, rawEnd: e, ordinal: ordinal++ });
      }
    }
    if (!clamped.length) {
      recordIgnoredLine(ln);
      continue;
    }
    parsedLineCount++;

    if (!grouped.has(key)) {
      grouped.set(key, { label, ranges: [] });
      order.push(key);
    }
    grouped.get(key).ranges.push(...clamped);
  }

  const rawGroups = order.map((key) => grouped.get(key));
  const diagnosticsBase = {
    sentenceCount,
    inputLineCount: lines.length,
    parsedLineCount,
    ignoredLineCount: lines.length - parsedLineCount,
    ignoredLineSamples,
    parsedRangeCount: ordinal,
    reversedRanges,
  };
  let result;
  try {
    result = finalizeGroups(rawGroups, sentenceCount, invalidRangeTokens);
  } catch (error) {
    if (error instanceof TopicParseError) {
      error.diagnostics = { ...error.diagnostics, ...diagnosticsBase };
    }
    throw error;
  }
  return {
    ...result,
    diagnostics: { ...result.diagnostics, ...diagnosticsBase },
  };
}
