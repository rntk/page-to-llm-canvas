import { describe, it, expect } from 'vitest';
import {
  splitTopicPath,
  getMaxTopicLevel,
  getTopicSentenceNumbers,
  splitSentenceRuns,
  getZoomAdjustedCardWidth,
  getTopicTitleFontSize,
  buildTopicCards,
  CARD_WIDTH,
  COLUMN_GAP,
  RAIL_PADDING,
} from './topicCards.js';

describe('constants', () => {
  it('exports expected card layout constants', () => {
    expect(CARD_WIDTH).toBe(240);
    expect(COLUMN_GAP).toBe(18);
    expect(RAIL_PADDING).toBe(24);
  });
});

describe('splitTopicPath', () => {
  it('splits a hierarchical path into parts', () => {
    expect(splitTopicPath('A > B > C')).toEqual(['A', 'B', 'C']);
  });

  it('returns a single-element array for a flat name', () => {
    expect(splitTopicPath('Tech')).toEqual(['Tech']);
  });

  it('handles paths without spaces around >', () => {
    expect(splitTopicPath('A>B>C')).toEqual(['A', 'B', 'C']);
  });

  it('returns empty array for null', () => {
    expect(splitTopicPath(null)).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    expect(splitTopicPath('')).toEqual([]);
  });

  it('filters empty segments', () => {
    expect(splitTopicPath('>A>>B>')).toEqual(['A', 'B']);
  });
});

describe('getMaxTopicLevel', () => {
  it('returns 0 for empty array', () => {
    expect(getMaxTopicLevel([])).toBe(0);
  });

  it('returns 0 for non-array', () => {
    expect(getMaxTopicLevel(null)).toBe(0);
  });

  it('returns 0 for flat topics', () => {
    expect(getMaxTopicLevel([{ name: 'Tech' }])).toBe(0);
  });

  it('returns max depth across all topics', () => {
    const topics = [{ name: 'Tech' }, { name: 'Tech > AI > Models' }, { name: 'Science > Bio' }];
    expect(getMaxTopicLevel(topics)).toBe(2);
  });
});

describe('getTopicSentenceNumbers', () => {
  it('returns empty array for null topic', () => {
    expect(getTopicSentenceNumbers(null)).toEqual([]);
  });

  it('returns sentenceIndices when present', () => {
    const topic = { sentenceIndices: [3, 1, 2] };
    expect(getTopicSentenceNumbers(topic)).toEqual([1, 2, 3]);
  });

  it('returns sentences when no sentenceIndices', () => {
    const topic = { sentences: [5, 3, 4] };
    expect(getTopicSentenceNumbers(topic)).toEqual([3, 4, 5]);
  });

  it('prefers sentenceIndices over sentences', () => {
    const topic = { sentenceIndices: [1], sentences: [5, 6] };
    expect(getTopicSentenceNumbers(topic)).toEqual([1]);
  });

  it('filters out non-positive integers', () => {
    const topic = { sentences: [0, -1, 2, 1.5, 3] };
    expect(getTopicSentenceNumbers(topic)).toEqual([2, 3]);
  });

  it('extracts from ranges when no explicit sentences', () => {
    const topic = { ranges: [{ sentence_start: 2, sentence_end: 5 }] };
    expect(getTopicSentenceNumbers(topic)).toEqual([2, 3, 4, 5]);
  });

  it('handles ranges with reversed start/end', () => {
    const topic = { ranges: [{ sentence_start: 5, sentence_end: 2 }] };
    expect(getTopicSentenceNumbers(topic)).toEqual([2, 3, 4, 5]);
  });

  it('handles single-sentence ranges', () => {
    const topic = { ranges: [{ sentence_start: 3 }] };
    expect(getTopicSentenceNumbers(topic)).toEqual([3]);
  });

  it('deduplicates across overlapping ranges', () => {
    const topic = {
      ranges: [
        { sentence_start: 1, sentence_end: 3 },
        { sentence_start: 3, sentence_end: 5 },
      ],
    };
    expect(getTopicSentenceNumbers(topic)).toEqual([1, 2, 3, 4, 5]);
  });

  it('returns empty array for empty ranges', () => {
    const topic = { ranges: [] };
    expect(getTopicSentenceNumbers(topic)).toEqual([]);
  });
});

describe('splitSentenceRuns', () => {
  it('returns empty array for empty input', () => {
    expect(splitSentenceRuns([])).toEqual([]);
  });

  it('returns single run for consecutive numbers', () => {
    expect(splitSentenceRuns([1, 2, 3])).toEqual([[1, 2, 3]]);
  });

  it('splits at gaps', () => {
    expect(splitSentenceRuns([1, 2, 5, 6])).toEqual([
      [1, 2],
      [5, 6],
    ]);
  });

  it('handles a single number', () => {
    expect(splitSentenceRuns([5])).toEqual([[5]]);
  });

  it('splits multiple gaps', () => {
    expect(splitSentenceRuns([1, 2, 5, 8, 9, 10])).toEqual([[1, 2], [5], [8, 9, 10]]);
  });
});

describe('getZoomAdjustedCardWidth', () => {
  it('returns CARD_WIDTH at scale 1', () => {
    expect(getZoomAdjustedCardWidth(1)).toBe(CARD_WIDTH);
  });

  it('grows when zoomed out (scale < 1)', () => {
    expect(getZoomAdjustedCardWidth(0.5)).toBeGreaterThan(CARD_WIDTH);
  });

  it('returns CARD_WIDTH when zoomed in (scale > 1)', () => {
    expect(getZoomAdjustedCardWidth(2)).toBe(CARD_WIDTH);
  });
});

describe('getTopicTitleFontSize', () => {
  it('returns a positive number for default params', () => {
    const size = getTopicTitleFontSize({ scale: 1, height: 72 });
    expect(size).toBeGreaterThan(0);
  });

  it('caps font size when height is very small', () => {
    const size = getTopicTitleFontSize({ scale: 1, height: 10 });
    expect(size).toBeGreaterThan(0);
    expect(size).toBeLessThan(12);
  });

  it('grows font size when zoomed out', () => {
    const normal = getTopicTitleFontSize({ scale: 1, height: 72 });
    const zoomedOut = getTopicTitleFontSize({ scale: 0.5, height: 72 });
    expect(zoomedOut).toBeGreaterThan(normal);
  });

  it('uses default height when height is not finite', () => {
    const withHeight = getTopicTitleFontSize({ scale: 1, height: 72 });
    const withoutHeight = getTopicTitleFontSize({ scale: 1, height: NaN });
    expect(withHeight).toBe(withoutHeight);
  });
});

describe('buildTopicCards', () => {
  it('returns empty array for null topics', () => {
    expect(buildTopicCards(null, 0)).toEqual([]);
  });

  it('returns empty array for non-array topics', () => {
    expect(buildTopicCards('not array', 0)).toEqual([]);
  });

  it('builds a card for a single flat topic', () => {
    const topics = [{ name: 'Tech', sentences: [1, 2, 3] }];
    const cards = buildTopicCards(topics, 0);
    expect(cards).toHaveLength(1);
    expect(cards[0].displayName).toBe('Tech');
    expect(cards[0].depth).toBe(0);
    expect(cards[0].levelIndex).toBe(0);
  });

  it('builds cards for a two-level hierarchy at selectedLevel 1', () => {
    const topics = [
      { name: 'Tech > AI', sentences: [1, 2] },
      { name: 'Tech > Web', sentences: [3, 4] },
    ];
    const cards = buildTopicCards(topics, 1);
    expect(cards.length).toBeGreaterThanOrEqual(2);
    const names = cards.map((c) => c.displayName);
    expect(names).toContain('AI');
    expect(names).toContain('Web');
  });

  it('assigns increasing right positions per depth level', () => {
    const topics = [{ name: 'A > B', sentences: [1] }];
    const cards = buildTopicCards(topics, 1);
    const depth0 = cards.filter((c) => c.depth === 0);
    const depth1 = cards.filter((c) => c.depth === 1);
    if (depth0.length && depth1.length) {
      expect(depth1[0].right).toBeGreaterThan(depth0[0].right);
    }
  });

  it('sorts cards by levelIndex then top position', () => {
    const topics = [
      { name: 'Tech > A', sentences: [1] },
      { name: 'Tech > B', sentences: [2] },
    ];
    const cards = buildTopicCards(topics, 1);
    for (let i = 1; i < cards.length; i++) {
      const prev = cards[i - 1];
      const curr = cards[i];
      if (prev.levelIndex === curr.levelIndex) {
        expect(curr.top).toBeGreaterThanOrEqual(prev.top);
      } else {
        expect(curr.levelIndex).toBeGreaterThan(prev.levelIndex);
      }
    }
  });

  it('uses sentence metrics for layout when provided', () => {
    const metrics = new Map([
      [1, { top: 100, bottom: 150 }],
      [2, { top: 200, bottom: 250 }],
    ]);
    const topics = [{ name: 'Tech', sentences: [1, 2] }];
    const cards = buildTopicCards(topics, 0, metrics);
    expect(cards).toHaveLength(1);
    expect(cards[0].top).toBe(100);
  });
});
