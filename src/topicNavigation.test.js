import { describe, expect, it } from 'vitest';
import {
  buildTopicNavigationList,
  findTopicNavigationTarget,
  getTopicNavigationCardTop,
} from './topicNavigation.js';

describe('topic navigation helpers', () => {
  it('keeps only cards from the currently selected topic level', () => {
    const topicCards = [
      { fullPath: 'A', startSentence: 1, levelIndex: 0, top: 10 },
      { fullPath: 'A > B', startSentence: 2, levelIndex: 1, top: 20 },
      { fullPath: 'C', startSentence: 3, levelIndex: 0, top: 30 },
      { fullPath: 'C > D', startSentence: 4, levelIndex: 1, top: 40 },
    ];

    expect(
      buildTopicNavigationList({
        showSummaryMode: false,
        summaryCards: [],
        topicCards,
        selectedLevel: 0,
      }).map((card) => card.fullPath),
    ).toEqual(['A', 'C']);

    expect(
      buildTopicNavigationList({
        showSummaryMode: false,
        summaryCards: [],
        topicCards,
        selectedLevel: 1,
      }).map((card) => card.fullPath),
    ).toEqual(['A > B', 'C > D']);
  });

  it('uses the closest card when the current selection is not in the selected level', () => {
    const list = [
      { fullPath: 'A > B', top: 100 },
      { fullPath: 'C > D', top: 250 },
      { fullPath: 'E > F', top: 700 },
    ];

    expect(
      findTopicNavigationTarget({
        list,
        selectedTopicKey: 'A',
        direction: 'next',
        currentY: 230,
        showSummaryMode: false,
      }).fullPath,
    ).toBe('C > D');
  });

  it('moves from the selected card within the current level after a match exists', () => {
    const list = [
      { fullPath: 'A > B', top: 100 },
      { fullPath: 'C > D', top: 250 },
      { fullPath: 'E > F', top: 700 },
    ];

    expect(
      findTopicNavigationTarget({
        list,
        selectedTopicKey: 'C > D',
        direction: 'next',
        currentY: 230,
        showSummaryMode: false,
      }).fullPath,
    ).toBe('E > F');
  });

  it('filters summary mode navigation to the selected summary depth', () => {
    const summaryCards = [
      { path: 'A', startSentence: 1, levelIndex: 0 },
      { path: 'A > B', startSentence: 2, levelIndex: 1 },
      { path: 'C', startSentence: 3, levelIndex: 0 },
    ];

    expect(
      buildTopicNavigationList({
        showSummaryMode: true,
        summaryCards,
        topicCards: [],
        selectedLevel: 0,
      }).map((card) => card.path),
    ).toEqual(['A', 'C']);
  });

  it('resolves summary card top from measured summary metrics', () => {
    const metrics = new Map([
      ['A#0#0', { top: 120 }],
      ['A', { top: 90 }],
    ]);

    expect(getTopicNavigationCardTop({ key: 'A#0#0', path: 'A', top: 10 }, true, metrics)).toBe(
      120,
    );
    expect(getTopicNavigationCardTop({ fullPath: 'A', top: 10 }, false, metrics)).toBe(10);
  });
});
