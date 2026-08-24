import { describe, expect, it } from 'vitest';
import {
  buildCanvasTopicPan,
  buildTopicNavigationList,
  findTopicNavigationTarget,
  getTopicNavigationCardKey,
  getTopicNavigationCardTop,
  getTopicNavigationTopicKey,
  resolveCanvasTopicNavigation,
} from './topicNavigation.js';

describe('topic navigation helpers', () => {
  it('keeps visible leaf cards for the selected topic depth', () => {
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

  it('includes shallow leaf and deep leaf topic cards when both are visible at selectedLevel', () => {
    const topicCards = [
      { fullPath: 'Science', startSentence: 1, levelIndex: 0, top: 10 },
      { fullPath: 'Tech', startSentence: 2, levelIndex: 0, top: 20 },
      { fullPath: 'Tech > AI', startSentence: 4, levelIndex: 1, top: 40 },
      { fullPath: 'Tech > AI > Models', startSentence: 10, levelIndex: 2, top: 100 },
      { fullPath: 'Culture', startSentence: 12, levelIndex: 0, top: 120 },
      { fullPath: 'Culture > Film', startSentence: 14, levelIndex: 1, top: 140 },
    ];

    const result = buildTopicNavigationList({
      showSummaryMode: false,
      summaryCards: [],
      topicCards,
      selectedLevel: 2,
    }).map((card) => card.fullPath);

    expect(result).toEqual(['Science', 'Tech > AI > Models', 'Culture > Film']);
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

  it('prefers selected navigation key when a topic has multiple rendered cards', () => {
    const list = [
      { key: 'A#0#0', fullPath: 'A', top: 100 },
      { key: 'A#0#1', fullPath: 'A', top: 400 },
      { key: 'B#0#0', fullPath: 'B', top: 700 },
    ];

    expect(
      findTopicNavigationTarget({
        list,
        selectedNavigationKey: 'A#0#1',
        selectedTopicKey: 'A',
        direction: 'prev',
        currentY: 390,
        showSummaryMode: false,
      }).key,
    ).toBe('A#0#0');
  });

  it('jumps directly to the first or last card', () => {
    const list = [
      { fullPath: 'A > B', top: 100 },
      { fullPath: 'C > D', top: 250 },
      { fullPath: 'E > F', top: 700 },
    ];

    expect(
      findTopicNavigationTarget({
        list,
        selectedTopicKey: 'C > D',
        direction: 'first',
        currentY: 230,
        showSummaryMode: false,
      }).fullPath,
    ).toBe('A > B');

    expect(
      findTopicNavigationTarget({
        list,
        selectedTopicKey: 'C > D',
        direction: 'last',
        currentY: 230,
        showSummaryMode: false,
      }).fullPath,
    ).toBe('E > F');
  });

  it('trusts already-filtered summaryCards in summary mode (no level re-filtering)', () => {
    const summaryCards = [
      { path: 'A', startSentence: 1, levelIndex: 0 },
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

  it('includes shallow leaf and deep leaf summary cards when both are visible at selectedLevel', () => {
    // filterSummaryCardsByLevel keeps shallow leaves (Science at 0) when no deeper
    // cards exist for that branch, even if selectedLevel is deeper (2).
    const summaryCards = [
      { path: 'Science', startSentence: 1, levelIndex: 0 },
      { path: 'Tech > AI > Models', startSentence: 10, levelIndex: 2 },
    ];

    const result = buildTopicNavigationList({
      showSummaryMode: true,
      summaryCards,
      topicCards: [],
      selectedLevel: 2,
    }).map((card) => card.path);

    expect(result).toEqual(['Science', 'Tech > AI > Models']);
  });

  it('resolves summary card top from measured summary metrics and returns null until measured', () => {
    const metrics = new Map([
      ['A#0#0', { top: 120 }],
      ['A', { top: 90 }],
    ]);

    expect(getTopicNavigationCardTop({ key: 'A#0#0', path: 'A', top: 10 }, true, metrics)).toBe(
      120,
    );
    expect(getTopicNavigationCardTop({ fullPath: 'A', top: 10 }, false, metrics)).toBe(10);
    expect(getTopicNavigationCardTop({ key: 'B#0#0', path: 'B', top: 10 }, true, metrics)).toBe(
      null,
    );
  });

  it('normalizes navigation card identity by mode', () => {
    expect(getTopicNavigationCardKey({ key: 'A#0#0', path: 'A' })).toBe('A#0#0');
    expect(getTopicNavigationTopicKey({ key: 'A#0#0', path: 'A' }, true)).toBe('A');
    expect(getTopicNavigationCardKey({ key: 'A#0#0', fullPath: 'A' })).toBe('A#0#0');
    expect(getTopicNavigationTopicKey({ key: 'A#0#0', fullPath: 'A' }, false)).toBe('A');
  });

  it.each([
    ['first-topic', 'A'],
    ['prev-topic', 'A'],
    ['next-topic', 'C'],
    ['last-topic', 'D'],
  ])('resolves %s through the pure navigation seam', (position, expectedPath) => {
    const topicCards = [
      { key: 'A#0', fullPath: 'A', startSentence: 1, levelIndex: 0, top: 10 },
      { key: 'B#0', fullPath: 'B', startSentence: 2, levelIndex: 0, top: 20 },
      { key: 'C#0', fullPath: 'C', startSentence: 3, levelIndex: 0, top: 30 },
      { key: 'D#0', fullPath: 'D', startSentence: 4, levelIndex: 0, top: 40 },
    ];

    const result = resolveCanvasTopicNavigation({
      position,
      showSummaryMode: false,
      summaryCards: [],
      topicCards,
      selectedLevel: 0,
      selectedNavigationKey: 'B#0',
      selectedTopicKey: 'B',
      currentY: 20,
    });

    expect(result.handled).toBe(true);
    expect(result.targetCard.fullPath).toBe(expectedPath);
  });

  it('distinguishes non-topic controls from a topic navigation with no target', () => {
    expect(
      resolveCanvasTopicNavigation({
        position: 'left',
        showSummaryMode: false,
        topicCards: [],
      }),
    ).toEqual({ handled: false, targetCard: null });

    expect(
      resolveCanvasTopicNavigation({
        position: 'next-topic',
        showSummaryMode: false,
        topicCards: [],
      }),
    ).toEqual({ handled: true, targetCard: null });
  });

  it('returns article and summary selection keys using their mode-specific identities', () => {
    const article = resolveCanvasTopicNavigation({
      position: 'first-topic',
      showSummaryMode: false,
      topicCards: [
        { key: 'Article#0', fullPath: 'Article', startSentence: 1, levelIndex: 0, top: 10 },
      ],
      selectedLevel: 0,
    });
    expect(article).toMatchObject({ topicKey: 'Article', cardKey: 'Article#0' });

    const summary = resolveCanvasTopicNavigation({
      position: 'first-topic',
      showSummaryMode: true,
      summaryCards: [{ key: 'Summary#0', path: 'Summary', startSentence: 1 }],
    });
    expect(summary).toMatchObject({ topicKey: 'Summary', cardKey: 'Summary#0' });
  });

  it('returns no pan when the card top is invalid or not measured', () => {
    expect(
      buildCanvasTopicPan({
        card: { top: Number.NaN },
        showSummaryMode: false,
        viewportHeight: 600,
        scale: 2,
        translate: { x: 10, y: 20 },
      }),
    ).toBeNull();

    expect(
      buildCanvasTopicPan({
        card: { key: 'A#0', path: 'A' },
        showSummaryMode: true,
        summaryMetricsState: new Map(),
        viewportHeight: 600,
        scale: 2,
        translate: { x: 10, y: 20 },
      }),
    ).toBeNull();
  });

  it('builds the translated pan while preserving horizontal transform state', () => {
    expect(
      buildCanvasTopicPan({
        card: { top: 150 },
        showSummaryMode: false,
        viewportHeight: 600,
        scale: 2,
        translate: { x: 42, y: 999 },
      }),
    ).toEqual({ scale: 2, translate: { x: 42, y: -180 } });
  });
});
