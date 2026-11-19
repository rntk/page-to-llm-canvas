import { describe, it, expect } from 'vitest';
import { suggestBetterLevel } from '../shared/levelHint.js';
import {
  gapsFromLevelCards,
  suggestLevelForCursor,
  SUMMARY_LEVEL_HINT_TOLERANCE_PX,
} from './summaryLevelHint.js';

const card = (top, height) => ({ id: `c-${top}`, box: { top, height } });

describe('summaryLevelHint', () => {
  const levelCards = new Map([
    [0, [card(0, 1000)]],
    [1, [card(0, 200), card(600, 200)]],
  ]);

  it('measures the gap from the cursor to each level in card-box space', () => {
    expect([...gapsFromLevelCards(levelCards, 400)]).toEqual([
      [0, 0],
      [1, 200],
    ]);
    expect([...gapsFromLevelCards(levelCards, 100)]).toEqual([
      [0, 0],
      [1, 0],
    ]);
  });

  it('gives a level without cards an infinite gap and tolerates bad input', () => {
    expect(gapsFromLevelCards(new Map([[2, []]]), 10).get(2)).toBe(Infinity);
    expect(gapsFromLevelCards(undefined, 10).size).toBe(0);
  });

  it('suggests the covering level when the selected level has a gap', () => {
    expect(suggestLevelForCursor({ levelCards, selectedLevel: 1, relativeY: 400 })).toBe(0);
  });

  it('stays quiet when the selected level covers the cursor', () => {
    expect(suggestLevelForCursor({ levelCards, selectedLevel: 1, relativeY: 100 })).toBeNull();
  });

  it('counts a cursor within the tolerance of a box as covered', () => {
    const near = 200 + SUMMARY_LEVEL_HINT_TOLERANCE_PX;
    expect(suggestLevelForCursor({ levelCards, selectedLevel: 1, relativeY: near })).toBeNull();
    expect(suggestLevelForCursor({ levelCards, selectedLevel: 1, relativeY: near + 1 })).toBe(0);
  });

  it('hints for a cursor before the first or after the last card', () => {
    const cards = new Map([
      [0, [card(0, 2000)]],
      [1, [card(300, 100)]],
    ]);
    expect(suggestLevelForCursor({ levelCards: cards, selectedLevel: 1, relativeY: 50 })).toBe(0);
    expect(suggestLevelForCursor({ levelCards: cards, selectedLevel: 1, relativeY: 900 })).toBe(0);
  });

  it('suggests a child level when only it covers the cursor', () => {
    const cards = new Map([
      [0, [card(0, 100)]],
      [1, [card(500, 100)]],
    ]);
    expect(suggestLevelForCursor({ levelCards: cards, selectedLevel: 0, relativeY: 550 })).toBe(1);
  });

  it('suggests nothing when no level covers the cursor or the selected level is unknown', () => {
    expect(suggestLevelForCursor({ levelCards, selectedLevel: 1, relativeY: 5000 })).toBeNull();
    expect(suggestLevelForCursor({ levelCards, selectedLevel: 5, relativeY: 400 })).toBeNull();
  });

  describe('allocation-free scan', () => {
    const reference = ({ levelCards, selectedLevel, relativeY, tolerance }) => {
      const gaps = gapsFromLevelCards(levelCards, relativeY);
      if (!gaps.has(selectedLevel)) return null;
      return suggestBetterLevel({ selectedLevel, gaps, tolerance });
    };

    it('matches gapsFromLevelCards + suggestBetterLevel over many cursors and levels', () => {
      const many = new Map([
        [0, [card(0, 1500)]],
        [1, [card(0, 200), card(600, 200)]],
        [2, [card(100, 50), card(700, 80)]],
        [3, []],
        [4, [card(1000, 100), card(1000, 100)]],
      ]);
      for (const selectedLevel of [0, 1, 2, 3, 4, 9]) {
        for (let relativeY = -50; relativeY <= 1300; relativeY += 13) {
          for (const tolerance of [0, SUMMARY_LEVEL_HINT_TOLERANCE_PX, 100]) {
            const input = { levelCards: many, selectedLevel, relativeY, tolerance };
            expect(suggestLevelForCursor(input)).toBe(reference(input));
          }
        }
      }
    });

    it('treats the box end as exclusive and tolerates malformed input', () => {
      const cards = new Map([
        [0, [card(0, 100)]],
        [1, [card(0, 100)]],
      ]);
      expect(
        suggestLevelForCursor({
          levelCards: cards,
          selectedLevel: 1,
          relativeY: 100,
          tolerance: 0,
        }),
      ).toBeNull();
      expect(
        suggestLevelForCursor({ levelCards: cards, selectedLevel: 1, relativeY: NaN }),
      ).toBeNull();
      expect(
        suggestLevelForCursor({ levelCards: undefined, selectedLevel: 1, relativeY: 5 }),
      ).toBeNull();
    });

    it('returns early without reading other levels when the selected level covers', () => {
      const trap = new Proxy([], {
        get() {
          throw new Error('other level scanned');
        },
      });
      const cards = new Map([
        [1, [card(0, 200)]],
        [0, trap],
      ]);
      expect(
        suggestLevelForCursor({ levelCards: cards, selectedLevel: 1, relativeY: 100 }),
      ).toBeNull();
      expect(
        suggestLevelForCursor({
          levelCards: cards,
          selectedLevel: 1,
          relativeY: 200 + SUMMARY_LEVEL_HINT_TOLERANCE_PX,
        }),
      ).toBeNull();
    });
  });
});
