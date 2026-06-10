import { describe, it, expect } from 'vitest';
import { buildSummaryCards, filterSummaryCardsByLevel } from './summaryCards.js';

// Minimal card factory for filterSummaryCardsByLevel tests.
function makeCard(path, levelIndex, startSentence, overrides = {}) {
  const parts = path.split(' > ');
  return {
    key: `${path}#${levelIndex}#0`,
    path,
    name: parts[parts.length - 1],
    text: `Summary of ${path}`,
    sourceSentences: [],
    startSentence,
    levelIndex,
    ...overrides,
  };
}

describe('filterSummaryCardsByLevel', () => {
  it('returns empty array for empty input', () => {
    expect(filterSummaryCardsByLevel([], 0)).toEqual([]);
    expect(filterSummaryCardsByLevel([], 2)).toEqual([]);
  });

  it('returns only level-0 cards when selectedLevel is 0', () => {
    const cards = [
      makeCard('Tech', 0, 1),
      makeCard('Tech > AI', 1, 2),
      makeCard('Science', 0, 5),
    ];
    const result = filterSummaryCardsByLevel(cards, 0);
    expect(result.map((c) => c.path)).toEqual(['Tech', 'Science']);
  });

  it('returns leaf cards at the selected level when deeper cards exist', () => {
    // At level 1 the level-0 "Tech" card is superseded by "Tech > AI" and
    // "Tech > Web" — both children are eligible and have Tech as a prefix.
    const cards = [
      makeCard('Tech', 0, 1),
      makeCard('Tech > AI', 1, 2),
      makeCard('Tech > Web', 1, 8),
    ];
    const result = filterSummaryCardsByLevel(cards, 1);
    const paths = result.map((c) => c.path);
    expect(paths).not.toContain('Tech');
    expect(paths).toContain('Tech > AI');
    expect(paths).toContain('Tech > Web');
  });

  it('keeps the deepest available card for branches shorter than selectedLevel', () => {
    // "Science" only goes one level deep. At selectedLevel 2 it should still
    // appear because no eligible card with path "Science > *" exists.
    const cards = [
      makeCard('Science', 0, 5),
      makeCard('Tech', 0, 1),
      makeCard('Tech > AI', 1, 2),
      makeCard('Tech > AI > Models', 2, 3),
    ];
    const result = filterSummaryCardsByLevel(cards, 2);
    const paths = result.map((c) => c.path);
    expect(paths).toContain('Science');
    expect(paths).toContain('Tech > AI > Models');
    expect(paths).not.toContain('Tech');
    expect(paths).not.toContain('Tech > AI');
  });

  it('selectedLevel deeper than any branch returns all leaf cards', () => {
    const cards = [
      makeCard('A', 0, 1),
      makeCard('A > B', 1, 2),
      makeCard('C', 0, 10),
    ];
    // selectedLevel 5 is beyond any existing card; only leaves survive.
    const result = filterSummaryCardsByLevel(cards, 5);
    const paths = result.map((c) => c.path);
    expect(paths).toContain('A > B');
    expect(paths).toContain('C');
    expect(paths).not.toContain('A');
  });

  it('sorts by startSentence ascending', () => {
    const cards = [
      makeCard('C', 0, 20),
      makeCard('A', 0, 5),
      makeCard('B', 0, 10),
    ];
    const result = filterSummaryCardsByLevel(cards, 0);
    expect(result.map((c) => c.path)).toEqual(['A', 'B', 'C']);
  });

  it('breaks startSentence ties by path lexicographic order', () => {
    // Both cards start at sentence 1; path order decides.
    const cards = [
      makeCard('Zebra', 0, 1),
      makeCard('Alpha', 0, 1),
      makeCard('Mango', 0, 1),
    ];
    const result = filterSummaryCardsByLevel(cards, 0);
    expect(result.map((c) => c.path)).toEqual(['Alpha', 'Mango', 'Zebra']);
  });

  it('excludes cards above selectedLevel', () => {
    const cards = [
      makeCard('A', 0, 1),
      makeCard('A > B', 1, 2),
      makeCard('A > B > C', 2, 3),
    ];
    // At level 1 the level-2 card is ineligible.
    const result = filterSummaryCardsByLevel(cards, 1);
    const paths = result.map((c) => c.path);
    expect(paths).not.toContain('A > B > C');
    expect(paths).toContain('A > B');
  });

  it('handles multiple runs (same path, different runIndex) for a multi-run topic', () => {
    // A topic split into two sentence runs produces two cards with the same
    // path but different keys. Both should survive (no path-prefix relationship
    // between cards sharing the same path).
    const c1 = makeCard('Tech > AI', 1, 2, { key: 'Tech > AI#1#0' });
    const c2 = makeCard('Tech > AI', 1, 15, { key: 'Tech > AI#1#1' });
    const result = filterSummaryCardsByLevel([c1, c2], 1);
    expect(result).toHaveLength(2);
  });
});

describe('buildSummaryCards', () => {
  it('splits hierarchical index entry with discontinuous sentences into multiple cards', () => {
    const topicSummaryIndex = {
      'A > B': {
        text: 'Summary of B',
        bullets: ['Point 1', 'Point 2'],
        source_sentences: [1, 2, 3, 10, 11, 12],
        level: 1,
      },
    };

    const cards = buildSummaryCards([], null, topicSummaryIndex);

    expect(cards).toHaveLength(2);

    expect(cards[0]).toEqual({
      key: 'A > B#1#0',
      path: 'A > B',
      name: 'B',
      text: 'Summary of B\n- Point 1\n- Point 2',
      sourceSentences: [1, 2, 3],
      startSentence: 1,
      levelIndex: 1,
    });

    expect(cards[1]).toEqual({
      key: 'A > B#1#1',
      path: 'A > B',
      name: 'B',
      text: 'Summary of B\n- Point 1\n- Point 2',
      sourceSentences: [10, 11, 12],
      startSentence: 10,
      levelIndex: 1,
    });
  });

  it('splits legacy topics entry with discontinuous sentences into multiple cards', () => {
    const topics = [
      {
        name: 'A > C',
        sentences: [5, 6, 20, 21],
      },
    ];
    const topicSummaries = {
      'A > C': {
        text: 'Summary of C',
        source_sentences: [5, 6, 20, 21],
      },
    };

    const cards = buildSummaryCards(topics, topicSummaries, null);

    expect(cards).toHaveLength(2);

    expect(cards[0]).toEqual({
      key: 'A > C#1#0',
      path: 'A > C',
      name: 'C',
      text: 'Summary of C',
      sourceSentences: [5, 6],
      startSentence: 5,
      levelIndex: 1,
    });

    expect(cards[1]).toEqual({
      key: 'A > C#1#1',
      path: 'A > C',
      name: 'C',
      text: 'Summary of C',
      sourceSentences: [20, 21],
      startSentence: 20,
      levelIndex: 1,
    });
  });
});
