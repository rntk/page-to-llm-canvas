import { describe, it, expect } from 'vitest';
import {
  getTopicSentenceNumbers,
  splitPath,
  topicAccentColor,
  buildSummaryEntries,
  buildHierarchicalTopicEntries,
  splitIntoContiguousRuns,
} from './recordTransform.js';

// ── splitPath ──────────────────────────────────────────────────────────────

describe('splitPath', () => {
  it('splits a simple path by >', () => {
    expect(splitPath('A > B > C')).toEqual(['A', 'B', 'C']);
  });

  it('trims whitespace around parts', () => {
    expect(splitPath('  A  >  B  ')).toEqual(['A', 'B']);
  });

  it('filters empty parts', () => {
    expect(splitPath('A >> B')).toEqual(['A', 'B']);
  });

  it('returns empty array for empty string', () => {
    expect(splitPath('')).toEqual([]);
  });

  it('returns empty array for null/undefined', () => {
    expect(splitPath(null)).toEqual([]);
    expect(splitPath(undefined)).toEqual([]);
  });

  it('returns single part when no > present', () => {
    expect(splitPath('Topic')).toEqual(['Topic']);
  });
});

// ── getTopicSentenceNumbers ────────────────────────────────────────────────

describe('getTopicSentenceNumbers', () => {
  it('returns sorted sentences array when present', () => {
    const topic = { sentences: [3, 1, 2] };
    expect(getTopicSentenceNumbers(topic)).toEqual([1, 2, 3]);
  });

  it('prefers sentences over ranges', () => {
    const topic = { sentences: [5], ranges: [{ sentence_start: 1, sentence_end: 3 }] };
    expect(getTopicSentenceNumbers(topic)).toEqual([5]);
  });

  it('expands ranges when sentences is absent', () => {
    const topic = { ranges: [{ sentence_start: 2, sentence_end: 4 }] };
    expect(getTopicSentenceNumbers(topic)).toEqual([2, 3, 4]);
  });

  it('handles single-sentence range (sentence_end equals sentence_start)', () => {
    const topic = { ranges: [{ sentence_start: 3, sentence_end: 3 }] };
    expect(getTopicSentenceNumbers(topic)).toEqual([3]);
  });

  it('uses sentence_start when sentence_end is null', () => {
    const topic = { ranges: [{ sentence_start: 5, sentence_end: null }] };
    expect(getTopicSentenceNumbers(topic)).toEqual([5]);
  });

  it('uses sentence_start when sentence_end is undefined', () => {
    const topic = { ranges: [{ sentence_start: 7, sentence_end: undefined }] };
    expect(getTopicSentenceNumbers(topic)).toEqual([7]);
  });

  it('uses sentence_start when sentence_end is empty string', () => {
    const topic = { ranges: [{ sentence_start: 4, sentence_end: '' }] };
    expect(getTopicSentenceNumbers(topic)).toEqual([4]);
  });

  it('deduplicates overlapping ranges', () => {
    const topic = {
      ranges: [
        { sentence_start: 1, sentence_end: 3 },
        { sentence_start: 2, sentence_end: 4 },
      ],
    };
    expect(getTopicSentenceNumbers(topic)).toEqual([1, 2, 3, 4]);
  });

  it('skips ranges with non-integer values', () => {
    const topic = { ranges: [{ sentence_start: 'a', sentence_end: 3 }] };
    expect(getTopicSentenceNumbers(topic)).toEqual([]);
  });

  it('returns empty array for empty topic', () => {
    expect(getTopicSentenceNumbers({})).toEqual([]);
  });

  it('returns empty array when sentences is an empty array', () => {
    const topic = { sentences: [], ranges: [{ sentence_start: 0, sentence_end: 1 }] };
    // sentences is present but empty — falls through to ranges
    expect(getTopicSentenceNumbers(topic)).toEqual([0, 1]);
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
  describe('topic_summary_index path (preferred)', () => {
    it('builds entries from topic_summary_index', () => {
      const record = {
        topic_summary_index: {
          'Science > Physics': {
            level: 1,
            text: 'Physics summary',
            source_sentences: [2, 0, 1],
          },
        },
      };
      const { entries } = buildSummaryEntries(record);
      expect(entries).toHaveLength(1);
      const e = entries[0];
      expect(e.path).toBe('Science > Physics');
      expect(e.name).toBe('Physics');
      expect(e.text).toBe('Physics summary');
      expect(e.sourceSentences).toEqual([0, 1, 2]);
      expect(e.level).toBe(1);
    });

    it('infers level from path depth when entry.level is not a number', () => {
      const record = {
        topic_summary_index: {
          'A > B > C': { text: 'deep', source_sentences: [] },
        },
      };
      const { entries } = buildSummaryEntries(record);
      expect(entries[0].level).toBe(2);
    });

    it('skips empty-key entries', () => {
      const record = {
        topic_summary_index: {
          '': { text: 'ignored', source_sentences: [0] },
          Topic: { level: 0, text: 'kept', source_sentences: [1] },
        },
      };
      const { entries } = buildSummaryEntries(record);
      expect(entries).toHaveLength(1);
      expect(entries[0].name).toBe('Topic');
    });

    it('uses empty sourceSentences when source_sentences is not an array', () => {
      const record = {
        topic_summary_index: {
          Topic: { level: 0, text: 'x' },
        },
      };
      const { entries } = buildSummaryEntries(record);
      expect(entries[0].sourceSentences).toEqual([]);
    });

    it('populates sentenceNumbersByPath map', () => {
      const record = {
        topic_summary_index: {
          Topic: { level: 0, text: 'x', source_sentences: [3, 1] },
        },
      };
      const { sentenceNumbersByPath } = buildSummaryEntries(record);
      expect(sentenceNumbersByPath.get('Topic')).toEqual([1, 3]);
    });
  });

  describe('fallback to topic_summaries', () => {
    it('falls back when topic_summary_index is absent', () => {
      const record = {
        topics: [{ name: 'Tech', sentences: [0, 1] }],
        topic_summaries: {
          Tech: { text: 'Tech summary', source_sentences: [1, 0] },
        },
      };
      const { entries } = buildSummaryEntries(record);
      expect(entries).toHaveLength(1);
      expect(entries[0].text).toBe('Tech summary');
      expect(entries[0].sourceSentences).toEqual([0, 1]);
    });

    it('falls back when topic_summary_index is empty object', () => {
      const record = {
        topic_summary_index: {},
        topics: [{ name: 'A', sentences: [5] }],
        topic_summaries: {},
      };
      const { entries } = buildSummaryEntries(record);
      expect(entries).toHaveLength(1);
      expect(entries[0].name).toBe('A');
    });

    it('uses getTopicSentenceNumbers when topic_summaries has no source_sentences', () => {
      const record = {
        topics: [{ name: 'A', sentences: [2, 4] }],
        topic_summaries: { A: { text: 'A text' } },
      };
      const { entries } = buildSummaryEntries(record);
      expect(entries[0].sourceSentences).toEqual([2, 4]);
    });

    it('falls back to path key lookup in topic_summaries', () => {
      const record = {
        topics: [{ name: 'A > B', sentences: [1] }],
        topic_summaries: { 'A > B': { text: 'path lookup', source_sentences: [1] } },
      };
      const { entries } = buildSummaryEntries(record);
      expect(entries[0].text).toBe('path lookup');
    });

    it('handles empty topics array', () => {
      const record = { topics: [], topic_summaries: {} };
      const { entries } = buildSummaryEntries(record);
      expect(entries).toEqual([]);
    });

    it('handles missing topics and topic_summaries', () => {
      const { entries } = buildSummaryEntries({});
      expect(entries).toEqual([]);
    });
  });
});

// ── buildHierarchicalTopicEntries ──────────────────────────────────────────

describe('buildHierarchicalTopicEntries', () => {
  it('returns only root level nodes when selectedLevel is 0', () => {
    const record = {
      topics: [
        { name: 'Tech > AI', sentences: [0, 1] },
        { name: 'Tech > Web', sentences: [2] },
        { name: 'Science', sentences: [3] },
      ],
    };
    const result = buildHierarchicalTopicEntries(record, 0);
    expect(result.map((e) => e.path)).toEqual(['Tech', 'Science']);
    result.forEach((e) => expect(e.level).toBe(0));
  });

  it('includes child nodes when selectedLevel is 1', () => {
    const record = {
      topics: [
        { name: 'Tech > AI', sentences: [0] },
        { name: 'Tech > Web', sentences: [1] },
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
        { name: 'Tech > AI', sentences: [0, 1] },
        { name: 'Tech > Web', sentences: [2, 3] },
      ],
    };
    const result = buildHierarchicalTopicEntries(record, 0);
    const tech = result.find((e) => e.path === 'Tech');
    expect(tech.sentences).toEqual([0, 1, 2, 3]);
  });

  it('returns empty array for empty topics', () => {
    expect(buildHierarchicalTopicEntries({ topics: [] }, 0)).toEqual([]);
    expect(buildHierarchicalTopicEntries({}, 0)).toEqual([]);
  });

  it('does not include levels deeper than selectedLevel', () => {
    const record = {
      topics: [{ name: 'A > B > C', sentences: [0] }],
    };
    const result = buildHierarchicalTopicEntries(record, 1);
    const paths = result.map((e) => e.path);
    expect(paths).not.toContain('A > B > C');
    expect(paths).toContain('A > B');
  });

  it('filters to selectedLevel in buildRailCards context (level property matches depth)', () => {
    const record = {
      topics: [{ name: 'A > B', sentences: [0, 1] }],
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
    expect(splitIntoContiguousRuns([6, 1, 5, 2])).toEqual([[1, 2], [5, 6]]);
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
