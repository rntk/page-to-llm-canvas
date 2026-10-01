// Adapted from txt_splitt's TopicRangeParser and RepairingGapHandler.
// Parse topic ranges permissively: clamp out-of-bounds indexes, then resolve
// overlaps and gaps deterministically. Only a response with no parseable ranges
// raises TopicParseError.

import { decodeEntities } from './htmlEntities.js';
import { splitTopicPath } from '../../shared/runtime/topicPath.js';

// Decoded entities can contain path delimiters. Keep this literal character
// class in sync with the topic path delimiter if it changes.
const LABEL_SEGMENT_SPLIT_RE = /[:>]/u;

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
 * Decode entities and normalize whitespace so equivalent labels have the same
 * display spelling and dedup key.
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
    // Split decoded delimiters too, so encoded and literal paths share a key.
    for (const sub of part.split(LABEL_SEGMENT_SPLIT_RE)) {
      const s = sub.trim();
      if (s) out.push(s);
    }
  }
  return out;
}

/**
 * Fold case and spacing for comparison while preserving punctuation (for
 * example, "C++" and "C#" remain distinct). Display uses the original segment.
 *
 * @param {string} segment Display-normalized label segment.
 */
function normalizeSegmentKey(segment) {
  const key = segment.normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu, '');
  // Preserve a nonempty key if normalization removes every character.
  return key || segment;
}

/** The same hierarchy key used when parser groups are merged.
 * @param {string[]} parts Topic path segments.
 * @returns {string} Canonical path key.
 */
export function topicLabelKey(parts) {
  return parts.reduce((key, part) => `${key}\u0000${normalizeSegmentKey(part)}`, '');
}

/**
 * Pin each segment's display spelling under its folded parent path. The first
 * retained spelling wins; siblings with equivalent parent labels share it.
 */
function createLabelCanonicalizer() {
  // Separate parent and segment keys with NUL.
  const canonicalBySegment = new Map();

  /**
   * @param {string[]} parts Display-normalized, non-empty label segments.
   * @returns {{label: string[], key: string}} Canonical label and its dedup key.
   */
  return function canonicalizeLabel(parts) {
    const label = [];
    let key = '';
    for (const part of parts) {
      key = topicLabelKey([...label, part]);
      const known = canonicalBySegment.get(key);
      if (known === undefined) {
        canonicalBySegment.set(key, part);
        label.push(part);
      } else {
        label.push(known);
      }
    }
    return { label, key };
  };
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
 * Give the earliest range each overlapping index, then extend adjacent ranges
 * over gaps to cover [0, sentenceCount-1] exactly once.
 *
 * @param {Array<{label: string[], ranges: Array<{start: number, end: number}>}>} groups
 * @param {number} sentenceCount
 * @param {Array<object>} repairs Capped diagnostics for each coverage repair.
 * @returns {Array<{label: string[], ranges: Array<{start: number, end: number}>}>}
 */
function repairCoverage(groups, sentenceCount, repairs) {
  const maxIndex = sentenceCount - 1;

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
      if (lastAdded === null) {
        pushRepair(repairs, { type: 'gap-start', filledStart: 0, filledEnd: start - 1 });
        start = 0;
      } else {
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

  if (nextExpected <= maxIndex && lastAdded !== null) {
    const prev = adjusted[lastAdded.gi][lastAdded.idx];
    pushRepair(repairs, { type: 'gap-tail', filledStart: nextExpected, filledEnd: maxIndex });
    adjusted[lastAdded.gi][lastAdded.idx] = { start: prev.start, end: maxIndex };
  }

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
 * Merge labeled ranges and repair their coverage for both parser entry points.
 *
 * @param {Array<{label: string[], ranges: Array<{start: number, end: number}>}>} rawGroups
 * @param {number} sentenceCount
 * @param {number} invalidRangeTokens
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
    // Keep the diagnostics shape consistent on failure.
    diagnostics.repairs = [];
    diagnostics.repairsTruncated = false;
    throw new TopicParseError('No valid topic ranges found in response', diagnostics);
  }

  const repairs = [];
  groups = repairCoverage(groups, sentenceCount, repairs);
  diagnostics.repairs = repairs.slice(0, MAX_REPAIRS);
  diagnostics.repairsTruncated = Boolean(repairs.truncated);

  return { groups, diagnostics };
}

/**
 * Merge equal labels from flat segments and repair sentence coverage.
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
  const canonicalizeLabel = createLabelCanonicalizer();
  let ordinal = 0;
  for (const seg of segments) {
    if (!seg.label || !seg.label.length) continue;
    const range = clampRange(seg.start, seg.end, maxIndex);
    // A discarded segment cannot claim the displayed spelling.
    if (range === null) continue;
    const { label, key } = canonicalizeLabel(seg.label);
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

/**
 * Parse topic ranges and report diagnostics for deterministic repairs.
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
  const canonicalizeLabel = createLabelCanonicalizer();
  let ordinal = 0;
  let invalidRangeTokens = 0;
  let reversedRanges = 0;
  let parsedLineCount = 0;
  // Raw samples are only for verbose diagnostics, never parser metrics.
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
      // Choose the colon with the most valid range tokens after it. On ties,
      // prefer the earliest colon so annotations inside ranges stay in the tail.
      let idx = ln.indexOf(':');
      let bestValidTokens = -1;
      for (let i = idx; i !== -1; i = ln.indexOf(':', i + 1)) {
        const validTokens = parseRangeString(ln.slice(i + 1)).ranges.length;
        if (validTokens > bestValidTokens) {
          bestValidTokens = validTokens;
          idx = i;
        }
      }
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

    const parts = normalizeLabelParts(splitTopicPath(topicPath));
    if (!parts.length) {
      recordIgnoredLine(ln);
      continue;
    }

    const parsed = parseRangeString(rangesStr);
    invalidRangeTokens += parsed.invalidCount;
    const clamped = [];
    for (const [s, e] of parsed.ranges) {
      if (s > e) reversedRanges++;
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

    // Ignored lines cannot claim the displayed spelling.
    const { label, key } = canonicalizeLabel(parts);
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
