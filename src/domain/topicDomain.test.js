import { describe, it, expect } from 'vitest';
import {
  buildTopicHierarchyTree,
  canonicalTopicPath,
  computeMaxTopicLevelForRecord,
  flattenTopicHierarchy,
  normalizeSummaryRuns,
  requireTopicSummaryLevel,
  splitSentenceRuns,
} from './topicDomain.js';

describe('canonicalTopicPath', () => {
  it('uses unspaced separators for topic-path keys', () => {
    expect(canonicalTopicPath(' Tech > AI> Models ')).toBe('Tech>AI>Models');
  });

  it('drops empty segments left by stray separators', () => {
    expect(canonicalTopicPath('Tech >  > AI')).toBe('Tech>AI');
  });

  it('returns an empty string for missing or separator-only paths', () => {
    expect(canonicalTopicPath('')).toBe('');
    expect(canonicalTopicPath(null)).toBe('');
    expect(canonicalTopicPath(' > ')).toBe('');
  });
});

describe('requireTopicSummaryLevel', () => {
  it('returns a canonical non-negative integer level', () => {
    expect(requireTopicSummaryLevel('A > B', { level: 1 })).toBe(1);
  });

  it.each([null, {}, { level: -1 }, { level: 1.5 }, { level: Number.NaN }])(
    'rejects a malformed index entry: %j',
    (entry) => {
      expect(() => requireTopicSummaryLevel('A > B', entry)).toThrow(
        'Invalid topic_summary_index entry for "A > B"',
      );
    },
  );
});

// ── computeMaxTopicLevelForRecord ───────────────────────────────────────────

describe('computeMaxTopicLevelForRecord', () => {
  it('returns 0 for an empty record', () => {
    expect(computeMaxTopicLevelForRecord({})).toBe(0);
  });

  it('returns 0 for a nullish record', () => {
    expect(computeMaxTopicLevelForRecord(null)).toBe(0);
    expect(computeMaxTopicLevelForRecord(undefined)).toBe(0);
  });

  it('derives depth from topic name paths', () => {
    const record = {
      topics: [{ name: 'A' }, { name: 'A > B > C' }, { name: 'A > B' }],
    };
    expect(computeMaxTopicLevelForRecord(record)).toBe(2);
  });

  it('uses explicit entry.level from topic_summary_index', () => {
    const record = {
      topics: [{ name: 'A' }],
      topic_summary_index: {
        'A > B': { level: 4 },
      },
    };
    expect(computeMaxTopicLevelForRecord(record)).toBe(4);
  });

  it('skips empty-key summary index entries', () => {
    const record = {
      topics: [{ name: 'A > B' }],
      topic_summary_index: {
        '': { level: 9 },
      },
    };
    expect(computeMaxTopicLevelForRecord(record)).toBe(1);
  });

  it('takes the max across topics and topic_summary_index', () => {
    const record = {
      topics: [{ name: 'A > B' }],
      topic_summary_index: {
        'X > Y > Z': { level: 2 },
      },
    };
    expect(computeMaxTopicLevelForRecord(record)).toBe(2);
  });

  it('handles non-array topics and non-object index gracefully', () => {
    expect(computeMaxTopicLevelForRecord({ topics: null, topic_summary_index: null })).toBe(0);
  });

  it('rejects an index entry without an explicit canonical level', () => {
    expect(() =>
      computeMaxTopicLevelForRecord({
        topic_summary_index: { 'A > B': { runs: [] } },
      }),
    ).toThrow('Invalid topic_summary_index entry for "A > B"');
  });
});

describe('splitSentenceRuns', () => {
  it('returns an empty array for empty or non-array input', () => {
    expect(splitSentenceRuns([])).toEqual([]);
    expect(splitSentenceRuns(null)).toEqual([]);
    expect(splitSentenceRuns(undefined)).toEqual([]);
  });

  it('groups contiguous sentence numbers into one run', () => {
    expect(splitSentenceRuns([1, 2, 3, 4])).toEqual([[1, 2, 3, 4]]);
  });

  it('splits on gaps', () => {
    expect(splitSentenceRuns([1, 2, 5, 6, 10])).toEqual([[1, 2], [5, 6], [10]]);
  });

  it('sorts unsorted input instead of splitting it into spurious runs', () => {
    expect(splitSentenceRuns([6, 1, 5, 2])).toEqual([
      [1, 2],
      [5, 6],
    ]);
  });

  it('does not mutate the caller array', () => {
    const input = [3, 1, 2];
    splitSentenceRuns(input);
    expect(input).toEqual([3, 1, 2]);
  });
});

describe('normalizeSummaryRuns', () => {
  it('sorts run sentences and trims run text', () => {
    expect(normalizeSummaryRuns([{ sentences: [3, 1], text: '  hi  ' }], [])).toEqual([
      { sentences: [1, 3], text: 'hi' },
    ]);
  });

  it('coerces malformed run fields to empty values', () => {
    expect(normalizeSummaryRuns([{ sentences: 'nope', text: 7 }], [])).toEqual([
      { sentences: [], text: '' },
    ]);
  });

  it('falls back to text-less runs derived from the aggregated sentences', () => {
    expect(normalizeSummaryRuns([], [4, 1, 2])).toEqual([
      { sentences: [1, 2], text: '' },
      { sentences: [4], text: '' },
    ]);
  });

  it('returns no runs when there are neither runs nor sentences', () => {
    expect(normalizeSummaryRuns(undefined, undefined)).toEqual([]);
  });
});

describe('buildTopicHierarchyTree / flattenTopicHierarchy', () => {
  const topics = [
    { name: 'Tech > AI', sentences: [1, 2] },
    { name: 'Tech > Web', sentences: [3] },
    { name: 'Science', sentences: [4] },
  ];

  it('truncates the tree at maxLevel', () => {
    const nodes = flattenTopicHierarchy(buildTopicHierarchyTree(topics, 0));
    expect(nodes.map((node) => node.fullPath)).toEqual(['Tech', 'Science']);
    nodes.forEach((node) => expect(node.depth).toBe(0));
  });

  it('rolls descendant sentences up into ancestors', () => {
    const nodes = flattenTopicHierarchy(buildTopicHierarchyTree(topics, 1));
    const tech = nodes.find((node) => node.fullPath === 'Tech');
    expect(Array.from(tech.sentences).sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect(Array.from(tech.children.keys())).toEqual(['AI', 'Web']);
  });

  it('flattens in first-seen path order, not depth-first order', () => {
    const nodes = flattenTopicHierarchy(buildTopicHierarchyTree(topics, 1));
    expect(nodes.map((node) => node.fullPath)).toEqual([
      'Tech',
      'Tech > AI',
      'Tech > Web',
      'Science',
    ]);
  });

  it('ignores non-integer and non-positive sentence numbers', () => {
    const nodes = flattenTopicHierarchy(
      buildTopicHierarchyTree([{ name: 'A', sentences: [1, 0, -2, 1.5, null] }], 0),
    );
    expect(Array.from(nodes[0].sentences)).toEqual([1]);
  });

  it('returns a bare root for non-array topics', () => {
    expect(flattenTopicHierarchy(buildTopicHierarchyTree(null, 2))).toEqual([]);
  });

  it('treats a non-finite maxLevel as level 0', () => {
    const nodes = flattenTopicHierarchy(buildTopicHierarchyTree(topics, NaN));
    expect(nodes.map((node) => node.fullPath)).toEqual(['Tech', 'Science']);
  });
});
