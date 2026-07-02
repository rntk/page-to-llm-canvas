import { describe, expect, it } from 'vitest';
import { selectCurrentTopicSummary } from './utils/currentTopicSummary.js';

describe('selectCurrentTopicSummary', () => {
  const cards = [
    {
      key: 'Technology#0#0',
      path: 'Technology',
      text: 'First technology occurrence.',
      sourceSentences: [1, 2],
    },
    {
      key: 'Technology#0#1',
      path: 'Technology',
      text: 'Second technology occurrence.',
      sourceSentences: [20, 21],
    },
  ];

  it('prefers the active topic card key when a topic has multiple summary runs', () => {
    expect(
      selectCurrentTopicSummary({
        showSummaryMode: false,
        activeTopicKey: 'Technology',
        activeTopicCardKey: 'Technology#0#1',
        allSummaryCards: cards,
      }),
    ).toBe(cards[1]);
  });

  it('falls back to the first matching topic path when no active card key is available', () => {
    expect(
      selectCurrentTopicSummary({
        showSummaryMode: false,
        activeTopicKey: 'Technology',
        activeTopicCardKey: null,
        allSummaryCards: cards,
      }),
    ).toBe(cards[0]);
  });

  it('does not show the floating summary while summary mode is active', () => {
    expect(
      selectCurrentTopicSummary({
        showSummaryMode: true,
        activeTopicKey: 'Technology',
        activeTopicCardKey: 'Technology#0#1',
        allSummaryCards: cards,
      }),
    ).toBeNull();
  });
});
