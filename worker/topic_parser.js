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

const TOPIC_LINE_RE = /^(.+):\s*(\d[\d\s,-]*)\s*$/;
const RANGE_RE = /(\d+)\s*-\s*(\d+)/;
const SINGLE_RE = /(\d+)/;

/** Thrown when the LLM response contains no parseable topic ranges at all. */
export class TopicParseError extends Error {
  /**
   * @param {string} message
   * @param {{ outOfRange?: number[], duplicates?: number[], missing?: number[] }} diagnostics
   */
  constructor(message, diagnostics = {}) {
    super(message);
    this.name = 'TopicParseError';
    this.diagnostics = diagnostics;
  }
}

function normalizeLabelParts(parts) {
  const out = [];
  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;
    for (const sub of part.split(':')) {
      const s = sub.trim();
      if (s) out.push(s);
    }
  }
  return out;
}

function normalizeLabelKey(label) {
  return label.map((p) => p.toLowerCase().replace(/[^a-z0-9]/g, '')).join('|');
}

function parseRangeString(str) {
  const results = [];
  for (const partRaw of str.split(',')) {
    const part = partRaw.trim();
    if (part.includes('-') && !part.startsWith('-')) {
      const m = RANGE_RE.exec(part);
      if (m) {
        results.push([parseInt(m[1], 10), parseInt(m[2], 10)]);
        continue;
      }
    }
    const m = SINGLE_RE.exec(part);
    if (m) {
      const n = parseInt(m[1], 10);
      results.push([n, n]);
    }
  }
  return results;
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
  start = Math.max(0, Math.min(start, maxIndex));
  end = Math.max(0, Math.min(end, maxIndex));
  if (start > end) {
    const tmp = start;
    start = end;
    end = tmp;
  }
  return { start, end };
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
 * @returns {Array<{label: string[], ranges: Array<{start: number, end: number}>}>}
 */
function repairCoverage(groups, sentenceCount) {
  const maxIndex = sentenceCount - 1;

  // Flatten all (groupIndex, range) pairs and sort by (start, end).
  const flat = [];
  groups.forEach((g, gi) => {
    for (const r of g.ranges) flat.push({ gi, range: r });
  });
  flat.sort((a, b) => a.range.start - b.range.start || a.range.end - b.range.end);

  const adjusted = groups.map(() => []);
  let nextExpected = 0;
  let lastAdded = null; // { gi, idx } of the most recently appended range

  for (const { gi, range } of flat) {
    if (range.end < nextExpected) {
      // Entirely consumed by an earlier range (overlap) — drop it.
      continue;
    }
    let start = Math.max(range.start, nextExpected);
    if (start > range.end) continue;

    if (start > nextExpected) {
      // Gap before this range.
      if (lastAdded === null) {
        // Gap at the very beginning: pull this first range back to 0.
        start = 0;
      } else {
        // Gap in the middle: extend the previously-added range forward.
        const prev = adjusted[lastAdded.gi][lastAdded.idx];
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
    adjusted[lastAdded.gi][lastAdded.idx] = { start: prev.start, end: maxIndex };
  }

  // Rebuild groups in original order, dropping any that lost all ranges.
  const result = [];
  groups.forEach((g, gi) => {
    if (adjusted[gi].length) result.push({ label: g.label, ranges: adjusted[gi] });
  });
  return result;
}

// Returns Array<{ label: string[], ranges: Array<{start, end}> }> (inclusive 0-based).
export function parseTopicRanges(response, sentenceCount) {
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
      continue;
    }
    if (!topicPath) continue;

    let label = normalizeLabelParts(topicPath.split('>'));
    if (!label.length) continue;
    const key = normalizeLabelKey(label);
    if (!keyToCanonical.has(key)) keyToCanonical.set(key, label);
    label = keyToCanonical.get(key);

    const parsed = parseRangeString(rangesStr);
    const clamped = [];
    for (const [s, e] of parsed) {
      // Clamp to bounds (matches Python TopicRangeParser); never reject.
      const r = clampRange(s, e, maxIndex);
      if (r !== null) clamped.push(r);
    }
    if (!clamped.length) continue;

    if (!grouped.has(key)) {
      grouped.set(key, { label, ranges: [] });
      order.push(key);
    }
    grouped.get(key).ranges.push(...clamped);
  }

  let groups = [];
  for (const key of order) {
    const g = grouped.get(key);
    const merged = mergeRanges(g.ranges);
    if (!merged.length) continue;
    groups.push({ label: g.label, ranges: merged });
  }
  if (!groups.length) throw new TopicParseError('No valid topic ranges found in response', {});

  // Repair overlaps and gaps so coverage is continuous over [0, maxIndex].
  groups = repairCoverage(groups, sentenceCount);

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
  return joined;
}
