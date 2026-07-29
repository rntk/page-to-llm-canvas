import { describe, it, expect } from 'vitest';
import {
  topicAccentColor,
  buildSummaryEntries,
  buildHierarchicalTopicEntries,
  splitIntoContiguousRuns,
  computeMaxTopicLevel,
} from './railCards.js';

// ── computeMaxTopicLevel ───────────────────────────────────────────────────

describe('computeMaxTopicLevel', () => {
  it('returns 0 for an empty record', () => {
    expect(computeMaxTopicLevel({})).toBe(0);
  });

  it('derives depth from topic name paths', () => {
    const record = {
      topics: [{ name: 'A' }, { name: 'A > B > C' }, { name: 'A > B' }],
    };
    expect(computeMaxTopicLevel(record)).toBe(2);
  });

  it('uses explicit entry.level from topic_summary_index', () => {
    const record = {
      topics: [{ name: 'A' }],
      topic_summary_index: {
        'A > B': { level: 4 },
      },
    };
    expect(computeMaxTopicLevel(record)).toBe(4);
  });

  it('skips empty-key summary index entries', () => {
    const record = {
      topics: [{ name: 'A > B' }],
      topic_summary_index: {
        '': { level: 9 },
      },
    };
    expect(computeMaxTopicLevel(record)).toBe(1);
  });

  it('takes the max across topics and topic_summary_index', () => {
    const record = {
      topics: [{ name: 'A > B' }],
      topic_summary_index: {
        'X > Y > Z': { level: 2 },
      },
    };
    expect(computeMaxTopicLevel(record)).toBe(2);
  });

  it('handles non-array topics and non-object index gracefully', () => {
    expect(computeMaxTopicLevel({ topics: null, topic_summary_index: null })).toBe(0);
  });
});

// ── topicAccentColor ───────────────────────────────────────────────────────

describe('topicAccentColor', () => {
  it('returns an hsl() string', () => {
    expect(topicAccentColor('Tech', 0)).toMatch(/^hsl\(\d+, \d+%, \d+%\)$/);
  });

  it('is deterministic for same inputs', () => {
    expect(topicAccentColor('Tech', 2)).toBe(topicAccentColor('Tech', 2));
  });

  it('same root produces same hue regardless of depth', () => {
    const hue = (s) => Number(s.match(/hsl\((\d+)/)[1]);
    expect(hue(topicAccentColor('Tech > AI', 1))).toBe(hue(topicAccentColor('Tech > Web', 1)));
  });

  it('depth changes saturation and lightness', () => {
    expect(topicAccentColor('Tech', 0)).not.toBe(topicAccentColor('Tech', 3));
  });
});

// ── buildSummaryEntries ────────────────────────────────────────────────────

describe('buildSummaryEntries', () => {
  describe('topic_summary_index', () => {
    it('builds one entry per run from topic_summary_index', () => {
      const record = {
        topic_summary_index: {
          'Science > Physics': {
            level: 1,
            runs: [{ sentences: [3, 1, 2], text: 'Physics summary' }],
            source_sentences: [3, 1, 2],
          },
        },
      };
      const { entries } = buildSummaryEntries(record);
      expect(entries).toHaveLength(1);
      const e = entries[0];
      expect(e.path).toBe('Science > Physics');
      expect(e.name).toBe('Physics');
      expect(e.text).toBe('Physics summary');
      expect(e.sourceSentences).toEqual([1, 2, 3]);
      expect(e.level).toBe(1);
    });

    it('emits a separate entry for each non-adjacent run, each with its own text', () => {
      const record = {
        topic_summary_index: {
          Tech: {
            level: 0,
            runs: [
              { sentences: [1, 2], text: 'first occurrence' },
              { sentences: [9, 10], text: 'second occurrence' },
            ],
            source_sentences: [1, 2, 9, 10],
          },
        },
      };
      const { entries } = buildSummaryEntries(record);
      expect(entries).toEqual([
        { path: 'Tech', name: 'Tech', text: 'first occurrence', sourceSentences: [1, 2], level: 0 },
        {
          path: 'Tech',
          name: 'Tech',
          text: 'second occurrence',
          sourceSentences: [9, 10],
          level: 0,
        },
      ]);
    });

    it('rejects malformed index entries', () => {
      const record = {
        topic_summary_index: {
          'A > B > C': null,
        },
      };
      expect(() => buildSummaryEntries(record)).toThrow(
        'Invalid topic_summary_index entry for "A > B > C"',
      );
    });

    it('skips empty-key entries', () => {
      const record = {
        topic_summary_index: {
          '': { runs: [{ sentences: [0], text: 'ignored' }], source_sentences: [0] },
          Topic: { level: 0, runs: [{ sentences: [1], text: 'kept' }], source_sentences: [1] },
        },
      };
      const { entries } = buildSummaryEntries(record);
      expect(entries).toHaveLength(1);
      expect(entries[0].name).toBe('Topic');
    });

    it('falls back to positioned empty entries when an index entry has no runs', () => {
      const record = {
        topic_summary_index: {
          Topic: { level: 0, source_sentences: [1, 2, 7] },
        },
      };
      const { entries } = buildSummaryEntries(record);
      expect(entries.map((e) => ({ text: e.text, sourceSentences: e.sourceSentences }))).toEqual([
        { text: '', sourceSentences: [1, 2] },
        { text: '', sourceSentences: [7] },
      ]);
    });

    it('populates sentenceNumbersByPath map with the full aggregated source', () => {
      const record = {
        topic_summary_index: {
          Topic: { level: 0, runs: [{ sentences: [3, 1], text: 'x' }], source_sentences: [3, 1] },
        },
      };
      const { sentenceNumbersByPath } = buildSummaryEntries(record);
      expect(sentenceNumbersByPath.get('Topic')).toEqual([1, 3]);
    });
  });

  it('returns no summary entries when topic_summary_index is missing', () => {
    expect(buildSummaryEntries({}).entries).toEqual([]);
  });
});

// ── buildHierarchicalTopicEntries ──────────────────────────────────────────

describe('buildHierarchicalTopicEntries', () => {
  it('returns only root level nodes when selectedLevel is 0', () => {
    const record = {
      topics: [
        { name: 'Tech > AI', sentences: [1, 2] },
        { name: 'Tech > Web', sentences: [3] },
        { name: 'Science', sentences: [4] },
      ],
    };
    const result = buildHierarchicalTopicEntries(record, 0);
    expect(result.map((e) => e.path)).toEqual(['Tech', 'Science']);
    result.forEach((e) => expect(e.level).toBe(0));
  });

  it('includes child nodes when selectedLevel is 1', () => {
    const record = {
      topics: [
        { name: 'Tech > AI', sentences: [1] },
        { name: 'Tech > Web', sentences: [2] },
      ],
    };
    const result = buildHierarchicalTopicEntries(record, 1);
    const paths = result.map((e) => e.path);
    expect(paths).toContain('Tech');
    expect(paths).toContain('Tech > AI');
    expect(paths).toContain('Tech > Web');
  });

  it('accumulates sentences across topics sharing a parent', () => {
    const record = {
      topics: [
        { name: 'Tech > AI', sentences: [1, 2] },
        { name: 'Tech > Web', sentences: [3, 4] },
      ],
    };
    const result = buildHierarchicalTopicEntries(record, 0);
    const tech = result.find((e) => e.path === 'Tech');
    expect(tech.sentences).toEqual([1, 2, 3, 4]);
  });

  it('returns empty array for empty topics', () => {
    expect(buildHierarchicalTopicEntries({ topics: [] }, 0)).toEqual([]);
    expect(buildHierarchicalTopicEntries({}, 0)).toEqual([]);
  });

  it('does not include levels deeper than selectedLevel', () => {
    const record = {
      topics: [{ name: 'A > B > C', sentences: [1] }],
    };
    const result = buildHierarchicalTopicEntries(record, 1);
    const paths = result.map((e) => e.path);
    expect(paths).not.toContain('A > B > C');
    expect(paths).toContain('A > B');
  });

  it('filters to selectedLevel in buildRailCards context (level property matches depth)', () => {
    const record = {
      topics: [{ name: 'A > B', sentences: [1, 2] }],
    };
    const result = buildHierarchicalTopicEntries(record, 1);
    const atLevel1 = result.filter((e) => e.level === 1);
    expect(atLevel1.map((e) => e.name)).toEqual(['B']);
  });
});

// ── splitIntoContiguousRuns ────────────────────────────────────────────────

describe('splitIntoContiguousRuns', () => {
  it('returns empty array for empty input', () => {
    expect(splitIntoContiguousRuns([])).toEqual([]);
  });

  it('returns empty array for null/undefined', () => {
    expect(splitIntoContiguousRuns(null)).toEqual([]);
    expect(splitIntoContiguousRuns(undefined)).toEqual([]);
  });

  it('returns single run for single element', () => {
    expect(splitIntoContiguousRuns([5])).toEqual([[5]]);
  });

  it('returns single run when all elements are contiguous', () => {
    expect(splitIntoContiguousRuns([1, 2, 3, 4])).toEqual([[1, 2, 3, 4]]);
  });

  it('splits into multiple runs for fragmented input', () => {
    expect(splitIntoContiguousRuns([1, 2, 5, 6, 10])).toEqual([[1, 2], [5, 6], [10]]);
  });

  it('sorts input before splitting (unsorted input)', () => {
    expect(splitIntoContiguousRuns([6, 1, 5, 2])).toEqual([
      [1, 2],
      [5, 6],
    ]);
  });

  it('does not mutate the original array', () => {
    const input = [3, 1, 2];
    splitIntoContiguousRuns(input);
    expect(input).toEqual([3, 1, 2]);
  });

  it('handles gap of exactly 2 as two separate runs', () => {
    expect(splitIntoContiguousRuns([1, 3])).toEqual([[1], [3]]);
  });
});
