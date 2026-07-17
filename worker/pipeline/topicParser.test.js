import { describe, it, expect } from 'vitest';
import {
  parseTopicRanges,
  parseTopicRangesDetailed,
  groupsFromSegments,
  TopicParseError,
} from './topicParser.js';

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

  it('does not salvage numbers from malformed range tokens', () => {
    expect(() => parseTopicRanges('Tech>A: abc 2 def', 3)).toThrow(TopicParseError);
    expect(() => parseTopicRanges('Tech>A: -1', 3)).toThrow(TopicParseError);
    expect(() => parseTopicRanges('Tech>A: 1-2-3', 3)).toThrow(TopicParseError);
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

describe('parser quality diagnostics', () => {
  it('reports a clean parse without quirks', () => {
    const { diagnostics } = parseTopicRangesDetailed('Tech>A: 0-2', 3);
    expect(diagnostics).toMatchObject({
      sentenceCount: 3,
      inputLineCount: 1,
      parsedLineCount: 1,
      ignoredLineCount: 0,
      parsedRangeCount: 1,
      invalidRangeTokens: 0,
      reversedRanges: 0,
      outOfRange: [],
      duplicates: [],
      missing: [],
    });
  });

  it('reports every permissive repair and ignored output line', () => {
    const { diagnostics } = parseTopicRangesDetailed(
      'commentary without a range\nTech>A: 3-1, nope\nTech>B: 3-9',
      5,
    );
    expect(diagnostics).toMatchObject({
      inputLineCount: 3,
      parsedLineCount: 2,
      ignoredLineCount: 1,
      parsedRangeCount: 2,
      invalidRangeTokens: 1,
      reversedRanges: 1,
      outOfRange: [[3, 9]],
      duplicates: [3],
      missing: [0],
    });
  });

  it('enriches hard parse errors with response-shape diagnostics', () => {
    expect.assertions(2);
    try {
      parseTopicRangesDetailed('prose\nTech>A: nope', 4);
    } catch (error) {
      expect(error).toBeInstanceOf(TopicParseError);
      expect(error.diagnostics).toMatchObject({
        sentenceCount: 4,
        inputLineCount: 2,
        parsedLineCount: 0,
        ignoredLineCount: 2,
        invalidRangeTokens: 1,
      });
    }
  });
});

describe('ignoredLineSamples', () => {
  it('samples raw ignored lines (no colon, empty topic, empty label, zero ranges)', () => {
    const resp = [
      'no colon here',
      'Tech>A: 0-2',
      ': 1-2', // empty topic path
      '   >   : 1-2', // label parts all blank after normalization
      'Tech>B: nope', // zero clamped ranges
    ].join('\n');
    const { diagnostics } = parseTopicRangesDetailed(resp, 3);
    expect(diagnostics.ignoredLineCount).toBe(4);
    expect(diagnostics.ignoredLineSamples).toEqual([
      'no colon here',
      ': 1-2',
      '>   : 1-2',
      'Tech>B: nope',
    ]);
  });

  it('caps ignoredLineSamples at 10 entries', () => {
    const lines = Array.from({ length: 15 }, (_, i) => `garbage line ${i}`);
    const resp = ['Tech>A: 0-2', ...lines].join('\n');
    const { diagnostics } = parseTopicRangesDetailed(resp, 3);
    expect(diagnostics.ignoredLineCount).toBe(15);
    expect(diagnostics.ignoredLineSamples).toHaveLength(10);
    expect(diagnostics.ignoredLineSamples).toEqual(lines.slice(0, 10));
  });

  it('truncates sampled lines to 200 chars', () => {
    const longLine = 'x'.repeat(250);
    const resp = `Tech>A: 0-2\n${longLine}`;
    const { diagnostics } = parseTopicRangesDetailed(resp, 3);
    expect(diagnostics.ignoredLineSamples).toHaveLength(1);
    expect(diagnostics.ignoredLineSamples[0]).toHaveLength(200);
    expect(diagnostics.ignoredLineSamples[0]).toBe('x'.repeat(200));
  });

  it('is present (empty) on a clean parse', () => {
    const { diagnostics } = parseTopicRangesDetailed('Tech>A: 0-2', 3);
    expect(diagnostics.ignoredLineSamples).toEqual([]);
  });

  it('is attached to thrown TopicParseError diagnostics', () => {
    expect.assertions(1);
    try {
      parseTopicRangesDetailed('no colon here\njust text', 3);
    } catch (error) {
      expect(error.diagnostics.ignoredLineSamples).toEqual(['no colon here', 'just text']);
    }
  });
});

describe('repairs diagnostics', () => {
  it('reports overlap-trim and overlap-drop for trimmed/consumed ranges', () => {
    // A:0-3 and B:2-4 overlap on 2-3; A claimed first → B trimmed to start at 4.
    const { diagnostics } = parseTopicRangesDetailed('Tech>A: 0-3\nTech>B: 2-4', 5);
    expect(diagnostics.repairsTruncated).toBe(false);
    expect(diagnostics.repairs).toEqual([{ type: 'overlap-trim', start: 2, end: 4, newStart: 4 }]);
  });

  it('reports overlap-drop when a range is entirely consumed', () => {
    // A:0-4 fully covers B:1-2 → B is dropped entirely.
    const { diagnostics } = parseTopicRangesDetailed('Tech>A: 0-4\nTech>B: 1-2', 5);
    expect(diagnostics.repairs).toEqual([{ type: 'overlap-drop', start: 1, end: 2 }]);
  });

  it('reports gap-start when the first range does not begin at 0', () => {
    const { diagnostics } = parseTopicRangesDetailed('Tech>A: 2-4', 5);
    expect(diagnostics.repairs).toEqual([{ type: 'gap-start', filledStart: 0, filledEnd: 1 }]);
  });

  it('reports gap-middle when an interior gap extends the previous range', () => {
    const { diagnostics } = parseTopicRangesDetailed('Tech>A: 0-1\nTech>B: 3-4', 5);
    expect(diagnostics.repairs).toEqual([{ type: 'gap-middle', filledStart: 2, filledEnd: 2 }]);
  });

  it('reports gap-tail when the last range does not reach the final index', () => {
    const { diagnostics } = parseTopicRangesDetailed('Tech>A: 0-2', 5);
    expect(diagnostics.repairs).toEqual([{ type: 'gap-tail', filledStart: 3, filledEnd: 4 }]);
  });

  it('reports an empty, untruncated repairs list on a clean parse', () => {
    const { diagnostics } = parseTopicRangesDetailed('Tech>A: 0-4', 5);
    expect(diagnostics.repairs).toEqual([]);
    expect(diagnostics.repairsTruncated).toBe(false);
  });

  it('caps repairs at 50 entries and sets repairsTruncated', () => {
    // 60 single-sentence topics each separated by a gap sentence force 59 gap
    // repairs (interleaved singles create a gap before every other range).
    const lines = [];
    for (let i = 0; i < 60; i++) {
      lines.push(`Tech>T${i}: ${i * 2}`);
    }
    const sentenceCount = 60 * 2;
    const { diagnostics } = parseTopicRangesDetailed(lines.join('\n'), sentenceCount);
    expect(diagnostics.repairs.length).toBe(50);
    expect(diagnostics.repairsTruncated).toBe(true);
  });

  it('leaves existing diagnostics fields unchanged when repairs are added', () => {
    const { diagnostics } = parseTopicRangesDetailed('Tech>A: 0-1\nTech>B: 3-4', 5);
    expect(diagnostics).toMatchObject({
      sentenceCount: 5,
      inputLineCount: 2,
      parsedLineCount: 2,
      ignoredLineCount: 0,
      parsedRangeCount: 2,
      invalidRangeTokens: 0,
      reversedRanges: 0,
      outOfRange: [],
      duplicates: [],
      missing: [2],
    });
  });
});

// groupsFromSegments -------------------------------------------------------

describe('groupsFromSegments', () => {
  it('rebuilds groups from ordered labeled segments', () => {
    const groups = groupsFromSegments(
      [
        { label: ['Tech', 'AI'], start: 0, end: 2 },
        { label: ['Tech', 'Hardware'], start: 3, end: 5 },
      ],
      6,
    );
    expect(groups).toHaveLength(2);
    expect(groups[0].label).toEqual(['Tech', 'AI']);
    expect(groups[0].ranges).toEqual([{ start: 0, end: 2 }]);
    expect(groups[1].ranges).toEqual([{ start: 3, end: 5 }]);
  });

  it('merges segments that share a normalized label into one group', () => {
    // Two disjoint segments with the same topic must collapse to a single,
    // uniquely-named group (the invariant downstream summaries depend on).
    const groups = groupsFromSegments(
      [
        { label: ['Tech', 'AI'], start: 0, end: 1 },
        { label: ['Biz', 'Deal'], start: 2, end: 3 },
        { label: ['Tech', 'AI'], start: 4, end: 5 },
      ],
      6,
    );
    const aiGroups = groups.filter((g) => g.label.join('>') === 'Tech>AI');
    expect(aiGroups).toHaveLength(1);
    expect(aiGroups[0].ranges).toEqual([
      { start: 0, end: 1 },
      { start: 4, end: 5 },
    ]);
  });

  it('repairs gaps so coverage stays continuous', () => {
    const groups = groupsFromSegments(
      [
        { label: ['A', 'One'], start: 0, end: 1 },
        // Gap at 2-3 left by a dropped segment.
        { label: ['A', 'Two'], start: 4, end: 5 },
      ],
      6,
    );
    const covered = new Set();
    for (const g of groups) {
      for (const r of g.ranges) for (let i = r.start; i <= r.end; i++) covered.add(i);
    }
    expect([...covered].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('clamps and normalizes segment ranges before finalizing', () => {
    const groups = groupsFromSegments(
      [
        { label: ['A', 'One'], start: 4, end: 1 },
        { label: ['A', 'Two'], start: 20, end: 30 },
      ],
      5,
    );

    expect(groups[0].ranges).toEqual([{ start: 0, end: 4 }]);
  });

  it('drops segments with non-finite bounds', () => {
    const groups = groupsFromSegments(
      [
        { label: ['A', 'Bad'], start: Number.NaN, end: 2 },
        { label: ['A', 'Good'], start: 0, end: 2 },
      ],
      3,
    );

    expect(groups).toHaveLength(1);
    expect(groups[0].label).toEqual(['A', 'Good']);
  });
});

describe('label normalization', () => {
  it('does not collapse punctuation-distinct topic labels', () => {
    const groups = parseTopicRanges('Tech>C++: 0-1\nTech>C#: 2-3', 4);
    expect(groups.map((g) => g.label.join('>'))).toEqual(['Tech>C++', 'Tech>C#']);
  });

  it('canonicalizes segments with HTML entities and repeated whitespace', () => {
    const groups = parseTopicRanges(
      'Tech>Claude&nbsp;Tag>Intro: 0-1\nTech>Claude&nbsp;&nbsp;Tag>Features: 2-3\nTech>Claude   Tag>Demo: 4-5',
      6,
    );
    expect(groups.map((g) => g.label.join('>'))).toEqual([
      'Tech>Claude Tag>Intro',
      'Tech>Claude Tag>Features',
      'Tech>Claude Tag>Demo',
    ]);
  });

  it('merges same-topic lines that differ only in entity/whitespace encoding', () => {
    const groups = parseTopicRanges('Tech>Claude&nbsp;Tag: 0-1\nTech>Claude  Tag: 3-4', 5);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toEqual(['Tech', 'Claude Tag']);
  });

  it('collapses non-breaking-space characters inside segments', () => {
    const groups = parseTopicRanges('Tech>Claude  Tag: 0-2', 3);
    expect(groups[0].label).toEqual(['Tech', 'Claude Tag']);
  });
});

describe('overlap ordering', () => {
  it('uses response order when ranges start at the same sentence', () => {
    const groups = parseTopicRanges('Tech>Wide: 0-4\nTech>Narrow: 0-1', 5);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toEqual(['Tech', 'Wide']);
    expect(groups[0].ranges).toEqual([{ start: 0, end: 4 }]);
  });
});
