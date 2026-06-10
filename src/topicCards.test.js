import { describe, it, expect } from 'vitest';
import {
  splitTopicPath,
  getMaxTopicLevel,
  getTopicSentenceNumbers,
  splitSentenceRuns,
  getZoomAdjustedCardWidth,
  getZoomAdjustedSummaryCardWidth,
  getTopicTitleFontSize,
  buildTopicCards,
  resolveColumnOverlaps,
  patchTopicCardsFromSummaryMetrics,
  CARD_WIDTH,
  SUMMARY_CARD_WIDTH,
  SUMMARY_CARD_MAX_WIDTH,
  COLUMN_GAP,
  RAIL_PADDING,
} from './topicCards.js';

describe('constants', () => {
  it('exports expected card layout constants', () => {
    expect(CARD_WIDTH).toBe(240);
    expect(SUMMARY_CARD_WIDTH).toBe(442);
    expect(SUMMARY_CARD_MAX_WIDTH).toBe(988);
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

describe('getZoomAdjustedSummaryCardWidth', () => {
  it('returns SUMMARY_CARD_WIDTH at scale 1', () => {
    expect(getZoomAdjustedSummaryCardWidth(1)).toBe(SUMMARY_CARD_WIDTH);
  });

  it('grows when zoomed out', () => {
    expect(getZoomAdjustedSummaryCardWidth(0.5)).toBeGreaterThan(SUMMARY_CARD_WIDTH);
  });

  it('caps the summary card width', () => {
    expect(getZoomAdjustedSummaryCardWidth(0.3)).toBe(SUMMARY_CARD_MAX_WIDTH);
  });

  it('returns SUMMARY_CARD_WIDTH when zoomed in', () => {
    expect(getZoomAdjustedSummaryCardWidth(2)).toBe(SUMMARY_CARD_WIDTH);
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

  it('lets compact cards use spare vertical space for one larger readable line', () => {
    const zoomedOut = getTopicTitleFontSize({ scale: 0.5, height: 56 });
    expect(zoomedOut).toBeGreaterThan(18);
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

  it('emits one card per contiguous run for a non-contiguous topic', () => {
    const topics = [
      { name: 'News > Header', sentences: [1, 2] },
      { name: 'Body > Main', sentences: [3, 4, 5] },
      { name: 'News > Footer', sentences: [6, 7] },
    ];
    const cards = buildTopicCards(topics, 0);
    const newsCards = cards.filter((c) => c.fullPath === 'News');
    expect(newsCards).toHaveLength(2);
    expect(newsCards.map((c) => [c.startSentence, c.endSentence])).toEqual([
      [1, 2],
      [6, 7],
    ]);
  });

  it('gives each run of a non-contiguous topic its own non-overlapping fallback layout', () => {
    // "News" wraps around "Body" (header at 1-2, footer at 6-7). Without
    // measured metrics, the two News runs must not share one layout that
    // stacks them and stretches across the Body cards.
    const topics = [
      { name: 'News > Header', sentences: [1, 2] },
      { name: 'Body > Main', sentences: [3, 4, 5] },
      { name: 'News > Footer', sentences: [6, 7] },
    ];
    const cards = buildTopicCards(topics, 1);
    const level0 = cards.filter((c) => c.levelIndex === 0);
    expect(level0.map((c) => c.fullPath)).toEqual(['News', 'Body', 'News']);

    for (let i = 1; i < level0.length; i++) {
      const prev = level0[i - 1];
      expect(level0[i].top).toBeGreaterThanOrEqual(prev.top + prev.height);
    }

    // Each News run wraps only its own child, not the full column.
    const header = cards.find((c) => c.fullPath === 'News > Header');
    const footer = cards.find((c) => c.fullPath === 'News > Footer');
    const [newsTop, , newsBottom] = level0;
    expect(newsTop.top).toBe(header.top);
    expect(newsTop.top + newsTop.height).toBeLessThanOrEqual(footer.top);
    expect(newsBottom.top).toBe(footer.top);
  });

  it('never lets cards in a column overlap, even with corrupt sentence metrics', () => {
    // Sentence 2 is mis-measured far below the rest (e.g. fuzzy-matching a
    // repeated invisible preheader sentence to the wrong DOM text), stretching
    // News run 1 across the whole document.
    const metrics = new Map([
      [1, { top: 0, bottom: 30 }],
      [2, { top: 2000, bottom: 2030 }],
      [3, { top: 200, bottom: 300 }],
      [4, { top: 300, bottom: 400 }],
      [5, { top: 400, bottom: 500 }],
      [6, { top: 600, bottom: 650 }],
      [7, { top: 650, bottom: 700 }],
    ]);
    const topics = [
      { name: 'News > Header', sentences: [1, 2] },
      { name: 'Body > Main', sentences: [3, 4, 5] },
      { name: 'News > Footer', sentences: [6, 7] },
    ];
    const cards = buildTopicCards(topics, 0, metrics);
    const ordered = [...cards].sort((a, b) => a.top - b.top);
    expect(ordered.map((c) => c.fullPath)).toEqual(['News', 'Body', 'News']);
    for (let i = 1; i < ordered.length; i++) {
      const prev = ordered[i - 1];
      expect(ordered[i].top).toBeGreaterThanOrEqual(prev.top + prev.height);
    }
  });
});

describe('resolveColumnOverlaps', () => {
  const makeCard = (overrides) => ({
    key: 'A#0#0',
    fullPath: 'A',
    levelIndex: 0,
    startSentence: 1,
    top: 0,
    height: 72,
    ...overrides,
  });

  it('returns input unchanged shapes for empty or non-array input', () => {
    expect(resolveColumnOverlaps([])).toEqual([]);
    expect(resolveColumnOverlaps(null)).toBe(null);
  });

  it('leaves already-disjoint cards untouched', () => {
    const cards = [
      makeCard({ key: 'A#0#0', fullPath: 'A', startSentence: 1, top: 0, height: 72 }),
      makeCard({ key: 'B#0#0', fullPath: 'B', startSentence: 5, top: 100, height: 72 }),
    ];
    const resolved = resolveColumnOverlaps(cards);
    expect(resolved[0]).toMatchObject({ top: 0, height: 72 });
    expect(resolved[1]).toMatchObject({ top: 100, height: 72 });
  });

  it('clips a card that stretches over the next card in document order', () => {
    const cards = [
      makeCard({ key: 'A#0#0', fullPath: 'A', startSentence: 1, top: 0, height: 2000 }),
      makeCard({ key: 'B#0#0', fullPath: 'B', startSentence: 5, top: 400, height: 300 }),
    ];
    const [a, b] = resolveColumnOverlaps(cards);
    expect(a.top + a.height).toBeLessThanOrEqual(b.top);
    expect(b).toMatchObject({ top: 400, height: 300 });
  });

  it('pushes a card down when there is no room to clip the previous one', () => {
    const cards = [
      makeCard({ key: 'A#0#0', fullPath: 'A', startSentence: 1, top: 0, height: 72 }),
      makeCard({ key: 'B#0#0', fullPath: 'B', startSentence: 5, top: 10, height: 72 }),
    ];
    const [a, b] = resolveColumnOverlaps(cards);
    expect(b.top).toBeGreaterThanOrEqual(a.top + a.height);
  });

  it('only resolves overlaps within the same column', () => {
    const cards = [
      makeCard({
        key: 'A#0#0',
        fullPath: 'A',
        levelIndex: 0,
        startSentence: 1,
        top: 0,
        height: 500,
      }),
      makeCard({
        key: 'A > B#1#0',
        fullPath: 'A > B',
        levelIndex: 1,
        startSentence: 1,
        top: 0,
        height: 200,
      }),
    ];
    const resolved = resolveColumnOverlaps(cards);
    expect(resolved[0]).toMatchObject({ top: 0, height: 500 });
    expect(resolved[1]).toMatchObject({ top: 0, height: 200 });
  });
});

describe('patchTopicCardsFromSummaryMetrics', () => {
  // Minimal card factory matching the shape expected by the function.
  function makeTopicCard(overrides) {
    return {
      key: 'A#0#0',
      fullPath: 'A',
      displayName: 'A',
      sentenceCount: 1,
      startSentence: 1,
      endSentence: 3,
      top: 0,
      height: 72,
      titleFontSize: 12,
      depth: 0,
      levelIndex: 0,
      right: 24,
      ...overrides,
    };
  }

  // Minimal summary card factory.
  function makeSummaryCard(path, levelIndex, startSentence, runIndex = 0) {
    return {
      key: `${path}#${levelIndex}#${runIndex}`,
      path,
      name: path.split(' > ').pop(),
      text: '',
      sourceSentences: [],
      startSentence,
      levelIndex,
    };
  }

  it('returns overlap-resolved cards unchanged when metrics map is empty', () => {
    const card = makeTopicCard({ top: 50, height: 72 });
    const result = patchTopicCardsFromSummaryMetrics([card], [], new Map());
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ top: 50, height: 72 });
  });

  it('returns overlap-resolved cards unchanged when metrics is not a Map', () => {
    const card = makeTopicCard({ top: 50, height: 72 });
    const result = patchTopicCardsFromSummaryMetrics([card], [], null);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ top: 50, height: 72 });
  });

  it('patches card by exact key match', () => {
    const card = makeTopicCard({ key: 'A#0#0', fullPath: 'A', top: 0, height: 72 });
    const metrics = new Map([['A#0#0', { top: 200, height: 100 }]]);
    const result = patchTopicCardsFromSummaryMetrics([card], [], metrics);
    expect(result[0]).toMatchObject({ top: 200, height: 100 });
  });

  it('patches card by ancestor path matching (metric path is ancestor of card)', () => {
    // Metric key has path "A", card fullPath is "A > B" -> card.fullPath.startsWith("A > ")
    const card = makeTopicCard({
      key: 'A > B#1#0',
      fullPath: 'A > B',
      startSentence: 1,
      endSentence: 3,
      top: 0,
      height: 72,
      levelIndex: 1,
    });
    const summaryCard = makeSummaryCard('A', 0, 1);
    const metrics = new Map([[summaryCard.key, { top: 100, height: 80 }]]);
    const result = patchTopicCardsFromSummaryMetrics([card], [summaryCard], metrics);
    expect(result[0]).toMatchObject({ top: 100, height: 80 });
  });

  it('patches card by descendant path matching (metric path is descendant of card)', () => {
    // Metric key has path "A > B > C", card fullPath is "A" -> path.startsWith("A > ")
    const card = makeTopicCard({
      key: 'A#0#0',
      fullPath: 'A',
      startSentence: 1,
      endSentence: 5,
      top: 0,
      height: 72,
      levelIndex: 0,
    });
    const summaryCard = makeSummaryCard('A > B > C', 2, 2);
    const metrics = new Map([[summaryCard.key, { top: 150, height: 90 }]]);
    const result = patchTopicCardsFromSummaryMetrics([card], [summaryCard], metrics);
    expect(result[0]).toMatchObject({ top: 150, height: 90 });
  });

  it('accumulates bounding box across multiple matching metrics', () => {
    const card = makeTopicCard({
      key: 'A#0#0',
      fullPath: 'A',
      startSentence: 1,
      endSentence: 10,
      top: 0,
      height: 72,
      levelIndex: 0,
    });
    const s1 = makeSummaryCard('A > B', 1, 2);
    const s2 = makeSummaryCard('A > C', 1, 7);
    const metrics = new Map([
      [s1.key, { top: 100, height: 60 }],
      [s2.key, { top: 200, height: 50 }],
    ]);
    // top=100, bottom=max(160,250)=250, height=150
    const result = patchTopicCardsFromSummaryMetrics([card], [s1, s2], metrics);
    expect(result[0].top).toBe(100);
    expect(result[0].height).toBe(150);
  });

  it('enforces minimum height of 72 when bounding box collapses', () => {
    const card = makeTopicCard({
      key: 'A#0#0',
      fullPath: 'A',
      startSentence: 1,
      endSentence: 3,
      top: 0,
      height: 72,
      levelIndex: 0,
    });
    const s = makeSummaryCard('A > B', 1, 1);
    const metrics = new Map([[s.key, { top: 50, height: 0 }]]);
    const result = patchTopicCardsFromSummaryMetrics([card], [s], metrics);
    expect(result[0].height).toBeGreaterThanOrEqual(72);
  });

  it('skips summary metrics whose startSentence is outside card sentence range', () => {
    const card = makeTopicCard({
      key: 'A#0#0',
      fullPath: 'A',
      startSentence: 1,
      endSentence: 3,
      top: 10,
      height: 72,
      levelIndex: 0,
    });
    const s = makeSummaryCard('A > B', 1, 99);
    const metrics = new Map([[s.key, { top: 500, height: 100 }]]);
    const result = patchTopicCardsFromSummaryMetrics([card], [s], metrics);
    expect(result[0].top).toBe(10);
  });

  it('always patches when card has startSentence=0 and endSentence=0', () => {
    const card = makeTopicCard({
      key: 'A#0#0',
      fullPath: 'A',
      startSentence: 0,
      endSentence: 0,
      top: 0,
      height: 72,
      levelIndex: 0,
    });
    const s = makeSummaryCard('A > B', 1, 5);
    const metrics = new Map([[s.key, { top: 300, height: 80 }]]);
    const result = patchTopicCardsFromSummaryMetrics([card], [s], metrics);
    expect(result[0].top).toBe(300);
    expect(result[0].height).toBe(80);
  });

  it('re-runs overlap resolution after patching to eliminate collisions', () => {
    const card1 = makeTopicCard({
      key: 'A#0#0',
      fullPath: 'A',
      startSentence: 1,
      endSentence: 2,
      top: 0,
      height: 72,
      levelIndex: 0,
    });
    const card2 = makeTopicCard({
      key: 'B#0#0',
      fullPath: 'B',
      startSentence: 5,
      endSentence: 6,
      top: 80,
      height: 72,
      levelIndex: 0,
    });
    const sA = makeSummaryCard('A', 0, 1);
    const sB = makeSummaryCard('B', 0, 5);
    const metrics = new Map([
      [sA.key, { top: 0, height: 72 }],
      [sB.key, { top: 10, height: 72 }],
    ]);
    const result = patchTopicCardsFromSummaryMetrics([card1, card2], [sA, sB], metrics);
    const sorted = result.slice().sort((a, b) => a.top - b.top);
    const [r1, r2] = sorted;
    expect(r2.top).toBeGreaterThanOrEqual(r1.top + r1.height);
  });

  it('does not patch a card when no metric path matches its fullPath', () => {
    const card = makeTopicCard({
      key: 'Z#0#0',
      fullPath: 'Z',
      startSentence: 1,
      endSentence: 3,
      top: 20,
      height: 72,
      levelIndex: 0,
    });
    const s = makeSummaryCard('X', 0, 1);
    const metrics = new Map([[s.key, { top: 999, height: 200 }]]);
    const result = patchTopicCardsFromSummaryMetrics([card], [s], metrics);
    expect(result[0].top).toBe(20);
    expect(result[0].height).toBe(72);
  });
});
