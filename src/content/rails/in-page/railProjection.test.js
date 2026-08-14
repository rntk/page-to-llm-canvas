// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';

// computeCardVerticalBox measures live DOM ranges, which a projection test has
// no use for: stub it so each sentence run gets a deterministic box.
vi.mock('./geometry.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, computeCardVerticalBox: vi.fn() };
});

const { buildRailCards, FALLBACK_RAIL_BODY_HEIGHT } = await import('./railProjection.js');
const { computeCardVerticalBox, RAIL_TRAILING_PAD } = await import('./geometry.js');

/** Box every run 100px per starting sentence, 40px tall. */
function boxPerRun(run) {
  return { top: run[0] * 100, height: 40 };
}

function project(overrides = {}) {
  return buildRailCards({
    record: { topics: [{ name: 'Parent > Child', sentences: [1, 2] }] },
    mode: 'topics',
    selectedLevel: 0,
    sentenceRanges: new Map(),
    wordEntries: [],
    railOriginTop: 0,
    scrollContainer: window,
    ...overrides,
  });
}

describe('buildRailCards', () => {
  beforeEach(() => {
    computeCardVerticalBox.mockReset();
    computeCardVerticalBox.mockImplementation((run) => boxPerRun(run));
  });

  it('projects one card per contiguous run and keys it by path and run', () => {
    const { cards } = project({
      record: { topics: [{ name: 'Parent', sentences: [1, 2, 7, 8] }] },
    });

    expect(cards.map((c) => c.id)).toEqual(['Parent-1-2', 'Parent-7-8']);
    expect(cards.map((c) => c.sentences)).toEqual([
      [1, 2],
      [7, 8],
    ]);
    // allSentences keeps the topic's full set, sentences only this run's.
    expect(cards[0].allSentences).toEqual([1, 2, 7, 8]);
    expect(cards[0].accent).toBeTruthy();
  });

  it('keeps only entries at the selected level', () => {
    const record = { topics: [{ name: 'Parent > Child', sentences: [1, 2] }] };

    expect(project({ record, selectedLevel: 0 }).cards.map((c) => c.path)).toEqual(['Parent']);
    expect(project({ record, selectedLevel: 1 }).cards.map((c) => c.path)).toEqual([
      'Parent > Child',
    ]);
  });

  it('returns cards ascending by box top even when measured out of order', () => {
    // Inverted measurement: the later sentence measures higher up the page.
    computeCardVerticalBox.mockImplementation((run) => ({ top: 1000 - run[0] * 100, height: 40 }));
    const { cards } = project({
      record: {
        topics: [
          { name: 'First', sentences: [1] },
          { name: 'Second', sentences: [5] },
        ],
      },
    });

    // Overlap resolution stacks a level in sentence order, so the mis-measured
    // card is pushed below its predecessor rather than floating above it.
    expect(cards.map((c) => c.path)).toEqual(['First', 'Second']);
    expect(cards[0].box.top).toBeLessThan(cards[1].box.top);
  });

  it('drops runs that cannot be measured', () => {
    computeCardVerticalBox.mockImplementation((run) => (run[0] === 5 ? null : boxPerRun(run)));
    const { cards } = project({
      record: { topics: [{ name: 'Parent', sentences: [1, 5] }] },
    });

    expect(cards.map((c) => c.id)).toEqual(['Parent-1']);
  });

  it('resolves overlapping boxes within a level into a clean stack', () => {
    // Both runs measure as tall, overlapping boxes at the same level.
    computeCardVerticalBox.mockImplementation((run) => ({ top: run[0] * 10, height: 400 }));
    const { cards } = project({
      record: {
        topics: [
          { name: 'First', sentences: [1] },
          { name: 'Second', sentences: [5] },
        ],
      },
    });

    expect(cards).toHaveLength(2);
    const [top, bottom] = cards;
    expect(top.box.top + top.box.height).toBeLessThanOrEqual(bottom.box.top);
  });

  it('pads the rail body below the lowest card in topics mode', () => {
    const { cards, bodyHeight } = project({
      record: { topics: [{ name: 'Parent', sentences: [1, 5] }] },
    });

    const lowest = Math.max(...cards.map((c) => c.box.top + c.box.height));
    expect(bodyHeight).toBe(lowest + RAIL_TRAILING_PAD);
  });

  it('falls back to a fixed body height when nothing projects', () => {
    const { cards, bodyHeight } = project({ record: { topics: [] } });

    expect(cards).toEqual([]);
    expect(bodyHeight).toBe(FALLBACK_RAIL_BODY_HEIGHT);
  });

  it('projects summary runs with their text in summaries mode', () => {
    const record = {
      topic_summary_index: {
        Parent: {
          level: 0,
          runs: [{ sentences: [1, 2], text: 'Summary text' }],
          source_sentences: [1, 2],
        },
      },
    };
    const { cards, bodyHeight } = project({ record, mode: 'summaries' });

    expect(cards).toHaveLength(1);
    expect(cards[0].text).toBe('Summary text');
    expect(cards[0].sentences).toEqual([1, 2]);
    // Summaries reserve a viewport-sized run below the last card, so the body
    // grows past the flat topics pad.
    expect(bodyHeight).toBeGreaterThan(cards[0].box.top + cards[0].box.height + RAIL_TRAILING_PAD);
  });

  it('measures against the rail origin and scroll container it is given', () => {
    const scrollContainer = document.createElement('div');
    project({ railOriginTop: 250, scrollContainer });

    expect(computeCardVerticalBox).toHaveBeenCalledWith(
      [1, 2],
      expect.anything(),
      expect.anything(),
      250,
      scrollContainer,
    );
  });
});
