// Port of txt_splitt/sentences/parsers.py TopicRangeParser (text mode only) +
// AdjacentSameTopicJoiner (simple version: adjacent same-label lines merge).

const TOPIC_LINE_RE = /^(.+):\s*(\d[\d\s,\-]*)\s*$/;
const RANGE_RE = /(\d+)\s*-\s*(\d+)/;
const SINGLE_RE = /(\d+)/;

/** Thrown when the LLM response violates the exact-once coverage contract. */
export class TopicParseError extends Error {
  /**
   * @param {string} message
   * @param {{ outOfRange?: number[], duplicates?: number[], missing?: number[] }} diagnostics
   */
  constructor(message, diagnostics = {}) {
    super(message);
    this.name = "TopicParseError";
    this.diagnostics = diagnostics;
  }
}

function normalizeLabelParts(parts) {
  const out = [];
  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;
    for (const sub of part.split(":")) {
      const s = sub.trim();
      if (s) out.push(s);
    }
  }
  return out;
}

function normalizeLabelKey(label) {
  return label.map((p) => p.toLowerCase().replace(/[^a-z0-9]/g, "")).join("|");
}

function parseRangeString(str) {
  const results = [];
  for (const partRaw of str.split(",")) {
    const part = partRaw.trim();
    if (part.includes("-") && !part.startsWith("-")) {
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
 * Validates that every sentence index in [0, sentenceCount-1] is covered
 * exactly once across all parsed groups.  Throws TopicParseError if not.
 *
 * @param {Array<{start: number, end: number}>} allRanges - flat, merged 0-based ranges
 * @param {number} sentenceCount
 */
function validateCoverage(allRanges, sentenceCount) {
  const seen = new Map(); // index -> first topic key that claimed it

  const outOfRange = [];
  const duplicates = [];

  for (const r of allRanges) {
    // Detect out-of-range at the range boundary level — never iterate over
    // hallucinated indices, which could be arbitrarily large.
    const clampedStart = Math.max(0, r.start);
    const clampedEnd = Math.min(sentenceCount - 1, r.end);

    if (r.start < 0 || r.end >= sentenceCount) {
      // Record just the boundary values as representative diagnostics.
      if (r.start < 0 && !outOfRange.includes(r.start)) outOfRange.push(r.start);
      if (r.end >= sentenceCount && !outOfRange.includes(r.end)) outOfRange.push(r.end);
    }

    // Only iterate within the valid window; duplicates still need tracking.
    for (let i = clampedStart; i <= clampedEnd; i++) {
      if (seen.has(i)) {
        if (!duplicates.includes(i)) duplicates.push(i);
      } else {
        seen.set(i, true);
      }
    }
  }

  const missing = [];
  for (let i = 0; i < sentenceCount; i++) {
    if (!seen.has(i)) missing.push(i);
  }

  const problems = [];
  if (outOfRange.length) problems.push(`out-of-range markers: ${outOfRange.join(", ")}`);
  if (duplicates.length) problems.push(`duplicate markers: ${duplicates.join(", ")}`);
  if (missing.length) problems.push(`missing markers: ${missing.join(", ")}`);

  if (problems.length) {
    throw new TopicParseError(
      `Topic parse validation failed — ${problems.join("; ")}`,
      { outOfRange, duplicates, missing },
    );
  }
}

// Returns Array<{ label: string[], ranges: Array<{start, end}> }> (inclusive 0-based).
export function parseTopicRanges(response, sentenceCount) {
  if (sentenceCount <= 0) throw new Error("sentenceCount must be positive");
  const maxIndex = sentenceCount - 1;
  const lines = response.trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  const grouped = new Map(); // key -> { label, ranges[] }
  const order = [];
  const keyToCanonical = new Map();

  for (const ln of lines) {
    let topicPath, rangesStr;
    const m = TOPIC_LINE_RE.exec(ln);
    if (m) {
      topicPath = m[1].trim();
      rangesStr = m[2].trim();
    } else if (ln.includes(":")) {
      const idx = ln.indexOf(":");
      topicPath = ln.slice(0, idx).trim();
      rangesStr = ln.slice(idx + 1).trim();
    } else {
      continue;
    }
    if (!topicPath) continue;

    let label = normalizeLabelParts(topicPath.split(">"));
    if (!label.length) continue;
    const key = normalizeLabelKey(label);
    if (!keyToCanonical.has(key)) keyToCanonical.set(key, label);
    label = keyToCanonical.get(key);

    const parsed = parseRangeString(rangesStr);
    const valid = [];
    for (const [s, e] of parsed) {
      const start = Math.min(s, e);
      const end = Math.max(s, e);
      // Collect as-is; out-of-range detection happens in validateCoverage.
      valid.push({ start, end });
    }
    if (!valid.length) continue;

    if (!grouped.has(key)) {
      grouped.set(key, { label, ranges: [] });
      order.push(key);
    }
    grouped.get(key).ranges.push(...valid);
  }

  const groups = [];
  for (const key of order) {
    const g = grouped.get(key);
    const merged = mergeRanges(g.ranges);
    if (!merged.length) continue;
    groups.push({ label: g.label, ranges: merged });
  }
  if (!groups.length) throw new TopicParseError("No valid topic ranges found in response", {});

  // Validate exact-once coverage before returning.
  const allRanges = groups.flatMap((g) => g.ranges);
  validateCoverage(allRanges, sentenceCount);

  // AdjacentSameTopicJoiner: merge consecutive groups with identical labels.
  const joined = [];
  for (const g of groups) {
    const last = joined[joined.length - 1];
    if (last && last.label.length === g.label.length && last.label.every((p, i) => p === g.label[i])) {
      last.ranges = mergeRanges(last.ranges.concat(g.ranges));
    } else {
      joined.push({ label: g.label.slice(), ranges: g.ranges.slice() });
    }
  }
  return joined;
}
