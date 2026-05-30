import { describe, it, expect } from 'vitest';
import { parseTopicRanges, TopicParseError } from './topic_parser.js';

// Helpers -------------------------------------------------------------------

/** Build a valid response string covering indices 0..n-1 under a single topic. */
function singleTopic(n) {
  return `Tech>All: 0-${n - 1}`;
}

/** Build a valid response with two topics splitting n sentences at mid. */
function twoTopics(n) {
  const mid = Math.floor(n / 2) - 1;
  return `Tech>First: 0-${mid}\nTech>Second: ${mid + 1}-${n - 1}`;
}

// Valid output ---------------------------------------------------------------

describe('valid complete coverage', () => {
  it('single topic covering all 5 sentences', () => {
    const groups = parseTopicRanges(singleTopic(5), 5);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toEqual(['Tech', 'All']);
    expect(groups[0].ranges).toEqual([{ start: 0, end: 4 }]);
  });

  it('two topics covering 6 sentences', () => {
    const groups = parseTopicRanges(twoTopics(6), 6);
    expect(groups).toHaveLength(2);
  });

  it('non-contiguous ranges on same topic are merged', () => {
    const resp = 'Tech>Topic: 0-1, 4-5\nTech>Other: 2-3';
    const groups = parseTopicRanges(resp, 6);
    const topic = groups.find((g) => g.label.join('>') === 'Tech>Topic');
    expect(topic).toBeDefined();
    // Ranges should cover 0-1 and 4-5 (not merged because gap exists)
    const covered = topic.ranges.flatMap((r) => {
      const out = [];
      for (let i = r.start; i <= r.end; i++) out.push(i);
      return out;
    });
    expect(covered.sort((a, b) => a - b)).toEqual([0, 1, 4, 5]);
  });

  it('adjacent same-label groups are joined', () => {
    const resp = 'Tech>Same: 0-1\nTech>Same: 2-3';
    const groups = parseTopicRanges(resp, 4);
    expect(groups).toHaveLength(1);
    expect(groups[0].ranges).toEqual([{ start: 0, end: 3 }]);
  });

  it('single sentence document', () => {
    const groups = parseTopicRanges('Tech>Only: 0', 1);
    expect(groups).toHaveLength(1);
  });
});

// Helper: flatten group ranges into a sorted unique index list.
function coveredIndices(group) {
  const out = [];
  for (const r of group.ranges) {
    for (let i = r.start; i <= r.end; i++) out.push(i);
  }
  return out.sort((a, b) => a - b);
}

// Helper: assert groups cover [0, n-1] exactly once with no overlap or gap.
function expectExactCoverage(groups, n) {
  const seen = new Array(n).fill(0);
  for (const g of groups) {
    for (const i of coveredIndices(g)) seen[i] = (seen[i] || 0) + 1;
  }
  expect(seen).toEqual(new Array(n).fill(1));
}

// Out-of-range markers (clamped, not rejected) -------------------------------

describe('out-of-range markers are clamped', () => {
  it('clamps an over-shooting range end into bounds', () => {
    // 5 sentences (0-4), but response claims sentence 5 → clamp to 4.
    const groups = parseTopicRanges('Tech>A: 0-3\nTech>B: 4-5', 5);
    const a = groups.find((g) => g.label.join('>') === 'Tech>A');
    const b = groups.find((g) => g.label.join('>') === 'Tech>B');
    expect(a.ranges).toEqual([{ start: 0, end: 3 }]);
    expect(b.ranges).toEqual([{ start: 4, end: 4 }]);
    expectExactCoverage(groups, 5);
  });

  it('clamps a range entirely beyond bounds and still covers all', () => {
    // 10-20 clamps to 4-4, then the leading gap (0-3) pulls start back to 0.
    const groups = parseTopicRanges('Tech>A: 10-20', 5);
    expect(groups).toHaveLength(1);
    expect(groups[0].ranges).toEqual([{ start: 0, end: 4 }]);
    expectExactCoverage(groups, 5);
  });
});

// Missing coverage (gaps filled, not rejected) -------------------------------

describe('gaps are filled by extending adjacent ranges', () => {
  it('fills an interior gap by extending the previous range forward', () => {
    // Index 2 is omitted; previous range (A) absorbs it: A→0-2, B→3-4.
    const groups = parseTopicRanges('Tech>A: 0-1\nTech>B: 3-4', 5);
    const a = groups.find((g) => g.label.join('>') === 'Tech>A');
    const b = groups.find((g) => g.label.join('>') === 'Tech>B');
    expect(a.ranges).toEqual([{ start: 0, end: 2 }]);
    expect(b.ranges).toEqual([{ start: 3, end: 4 }]);
    expectExactCoverage(groups, 5);
  });

  it('fills a trailing gap by extending the last range to the end', () => {
    const groups = parseTopicRanges('Tech>A: 0-2', 5);
    expect(groups).toHaveLength(1);
    expect(groups[0].ranges).toEqual([{ start: 0, end: 4 }]);
    expectExactCoverage(groups, 5);
  });
});

// Duplicate/overlapping sentences (overlaps trimmed, not rejected) -----------

describe('overlaps are trimmed first-claim-wins', () => {
  it('gives contested indices to the earliest-starting topic', () => {
    // A:0-3 and B:2-4 overlap on 2-3; A claimed them first → B keeps only 4.
    const groups = parseTopicRanges('Tech>A: 0-3\nTech>B: 2-4', 5);
    const a = groups.find((g) => g.label.join('>') === 'Tech>A');
    const b = groups.find((g) => g.label.join('>') === 'Tech>B');
    expect(a.ranges).toEqual([{ start: 0, end: 3 }]);
    expect(b.ranges).toEqual([{ start: 4, end: 4 }]);
    expectExactCoverage(groups, 5);
  });

  it('absorbs overlapping ranges that share a topic label', () => {
    const groups = parseTopicRanges('Tech>A: 0-2\nTech>A: 1-4', 5);
    expect(groups).toHaveLength(1);
    expect(groups[0].ranges).toEqual([{ start: 0, end: 4 }]);
    expectExactCoverage(groups, 5);
  });
});

// Empty group ----------------------------------------------------------------

describe('empty group', () => {
  it('throws when response is entirely empty', () => {
    expect(() => parseTopicRanges('', 3)).toThrow(TopicParseError);
  });

  it('throws when all lines are unparseable', () => {
    expect(() => parseTopicRanges('no colon here\njust text', 3)).toThrow(TopicParseError);
  });
});

// Malformed numbering --------------------------------------------------------

describe('malformed numbering', () => {
  it('throws when markers are letters, not numbers', () => {
    // No valid ranges parsed → missing all → TopicParseError
    expect(() => parseTopicRanges('Tech>A: a-b', 3)).toThrow(TopicParseError);
  });

  it('handles reversed range (start > end) by normalising', () => {
    // e.g. LLM writes 4-0 for 5 sentences; should be treated as 0-4
    const resp = 'Tech>A: 4-0';
    expect(() => parseTopicRanges(resp, 5)).not.toThrow();
    const groups = parseTopicRanges(resp, 5);
    expect(groups[0].ranges).toEqual([{ start: 0, end: 4 }]);
  });

  it('throws when response has no recognisable range portion', () => {
    expect(() => parseTopicRanges('Tech>A:', 3)).toThrow(TopicParseError);
  });
});

// Hallucinated huge range -------------------------------------------------

describe('hallucinated huge range', () => {
  it('clamps fast without iterating billions of indices', () => {
    // A real hang would make this test time out. Clamping happens at the
    // boundary level, before any per-index iteration.
    const groups = parseTopicRanges('Tech>A: 0-999999999', 5);
    expect(groups).toHaveLength(1);
    expect(groups[0].ranges).toEqual([{ start: 0, end: 4 }]);
  });
});

describe('TopicParseError identity', () => {
  it('is an instance of Error', () => {
    try {
      parseTopicRanges('', 3);
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect(e).toBeInstanceOf(TopicParseError);
      expect(e.name).toBe('TopicParseError');
    }
  });

  it('repairs partial coverage instead of throwing', () => {
    // Previously threw on missing 2,3,4; now the trailing gap is filled.
    const groups = parseTopicRanges('Tech>A: 0-1', 5);
    expect(groups).toHaveLength(1);
    expect(groups[0].ranges).toEqual([{ start: 0, end: 4 }]);
  });

  it('carries a structured diagnostics object on the no-ranges error', () => {
    try {
      parseTopicRanges('no parseable ranges here', 5);
    } catch (e) {
      expect(e).toBeInstanceOf(TopicParseError);
      expect(e.diagnostics).toBeDefined();
    }
  });
});
