import { describe, it, expect } from 'vitest';
import { buildSummaryCards } from './summaryCards.js';

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
