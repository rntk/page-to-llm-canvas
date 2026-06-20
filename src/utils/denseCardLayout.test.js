import { describe, it, expect } from 'vitest';
import {
  BASE_TOPIC_TITLE_FONT_SIZE,
  CARD_COMPACT_HEIGHT_THRESHOLD,
  CARD_COMPACT_TITLE_MAX_LINES,
  CARD_TITLE_MAX_LINES,
  DENSE_CARD_GAP,
  DENSE_CARD_MIN_HEIGHT,
  adjustCrowdedLevelCards,
  cardsOverlapVertically,
  getAdjustedHierarchyCards,
  getAdjustedTitleFontSize,
  getCardLabelHeight,
  getCompactCardHeight,
  getDenseCardZIndex,
  getFiniteNumber,
  getSummaryFontSizes,
  getTitleLineBudget,
  nudgeCrowdedPair,
} from './denseCardLayout.js';

// ---------------------------------------------------------------------------
// getFiniteNumber
// ---------------------------------------------------------------------------
describe('getFiniteNumber', () => {
  it('returns the value when it is finite', () => {
    expect(getFiniteNumber(42, 0)).toBe(42);
    expect(getFiniteNumber(0, 99)).toBe(0);
    expect(getFiniteNumber(-5.5, 99)).toBe(-5.5);
  });

  it('returns the fallback for NaN', () => {
    expect(getFiniteNumber(NaN, 10)).toBe(10);
  });

  it('returns the fallback for Infinity and -Infinity', () => {
    expect(getFiniteNumber(Infinity, 7)).toBe(7);
    expect(getFiniteNumber(-Infinity, 7)).toBe(7);
  });

  it('returns the fallback for undefined', () => {
    expect(getFiniteNumber(undefined, 5)).toBe(5);
  });

  it('returns the fallback for null', () => {
    expect(getFiniteNumber(null, 3)).toBe(3);
  });

  it('returns the fallback for a string', () => {
    expect(getFiniteNumber('abc', 1)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// cardsOverlapVertically
// ---------------------------------------------------------------------------
describe('cardsOverlapVertically', () => {
  it('detects clear overlap', () => {
    const top = { top: 0, height: 60 };
    const bottom = { top: 50, height: 60 };
    expect(cardsOverlapVertically(top, bottom)).toBe(true);
  });

  it('detects overlap including the gap', () => {
    // topCard bottom edge is at 60, gap is 4 → effective bottom 64.
    // bottomCard starts at 63 → 64 > 63 so they overlap.
    const top = { top: 0, height: 60 };
    const bottom = { top: 63, height: 60 };
    expect(cardsOverlapVertically(top, bottom)).toBe(true);
  });

  it('treats cards that are exactly touching (gap==0 apart) as NOT overlapping', () => {
    // top ends at 60, gap = 4, bottom starts at 64 → 60+4 = 64, not > 64
    const top = { top: 0, height: 60 };
    const bottom = { top: 64, height: 60 };
    expect(cardsOverlapVertically(top, bottom)).toBe(false);
  });

  it('returns false for clearly separated cards', () => {
    const top = { top: 0, height: 60 };
    const bottom = { top: 200, height: 60 };
    expect(cardsOverlapVertically(top, bottom)).toBe(false);
  });

  it('handles NaN tops gracefully (non-finite → result is false)', () => {
    const top = { top: NaN, height: 60 };
    const bottom = { top: 0, height: 60 };
    // NaN + 60 + 4 > 0 → NaN > 0 → false
    expect(cardsOverlapVertically(top, bottom)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getCompactCardHeight
// ---------------------------------------------------------------------------
describe('getCompactCardHeight', () => {
  it('returns the original height when not crowded', () => {
    const card = { height: 80 };
    expect(getCompactCardHeight(card, false)).toBe(80);
  });

  it('reduces height by DENSE_CARD_HEIGHT_REDUCTION when crowded and height <= max compact', () => {
    const card = { height: 80 }; // 80 <= 96 (DENSE_CARD_MAX_COMPACT_HEIGHT)
    const result = getCompactCardHeight(card, true);
    expect(result).toBe(80 - 16); // 64
  });

  it('clamps reduced height to DENSE_CARD_MIN_HEIGHT', () => {
    const card = { height: 60 }; // 60 - 16 = 44, but min is 56
    const result = getCompactCardHeight(card, true);
    expect(result).toBe(DENSE_CARD_MIN_HEIGHT);
  });

  it('does not compact a card taller than DENSE_CARD_MAX_COMPACT_HEIGHT even when crowded', () => {
    const card = { height: 120 }; // 120 > 96
    expect(getCompactCardHeight(card, true)).toBe(120);
  });

  it('falls back to DENSE_CARD_MIN_HEIGHT when card.height is NaN', () => {
    const card = { height: NaN };
    // getFiniteNumber(NaN, 56) → 56; crowded but 56 <= 96 → max(56, 56-16)=56
    expect(getCompactCardHeight(card, true)).toBe(DENSE_CARD_MIN_HEIGHT);
  });

  it('falls back to DENSE_CARD_MIN_HEIGHT when card.height is undefined', () => {
    const card = {};
    expect(getCompactCardHeight(card, true)).toBe(DENSE_CARD_MIN_HEIGHT);
  });
});

// ---------------------------------------------------------------------------
// getTitleLineBudget
// ---------------------------------------------------------------------------
describe('getTitleLineBudget', () => {
  it('returns CARD_COMPACT_TITLE_MAX_LINES for heights below threshold', () => {
    expect(getTitleLineBudget(CARD_COMPACT_HEIGHT_THRESHOLD - 1)).toBe(
      CARD_COMPACT_TITLE_MAX_LINES,
    );
  });

  it('returns CARD_TITLE_MAX_LINES at exactly the threshold', () => {
    expect(getTitleLineBudget(CARD_COMPACT_HEIGHT_THRESHOLD)).toBe(CARD_TITLE_MAX_LINES);
  });

  it('returns CARD_TITLE_MAX_LINES for heights above threshold', () => {
    expect(getTitleLineBudget(200)).toBe(CARD_TITLE_MAX_LINES);
  });
});

// ---------------------------------------------------------------------------
// getAdjustedTitleFontSize
// ---------------------------------------------------------------------------
describe('getAdjustedTitleFontSize', () => {
  it('returns the fontSize unchanged when height is large enough', () => {
    // With height=200, lines=2, available=200-16-12-3=169, cap=169/2.4≈70 → fontSize=12 fits
    const card = { titleFontSize: 12 };
    expect(getAdjustedTitleFontSize(card, 200)).toBe(12);
  });

  it('clamps fontSize when the card is too short', () => {
    // height=30 (compact, 1 line), available=max(1,30-16-12-3)=max(1,-1)=1, cap=1/1.2≈0.83 → clamped to 1
    const card = { titleFontSize: 12 };
    expect(getAdjustedTitleFontSize(card, 30)).toBe(1);
  });

  it('never returns less than 1', () => {
    const card = { titleFontSize: 0.1 };
    expect(getAdjustedTitleFontSize(card, 40)).toBeGreaterThanOrEqual(1);
  });

  it('falls back to 12 when titleFontSize is NaN', () => {
    const card = { titleFontSize: NaN };
    const result = getAdjustedTitleFontSize(card, 200);
    expect(result).toBe(12);
  });

  it('falls back to 12 when titleFontSize is undefined', () => {
    const card = {};
    const result = getAdjustedTitleFontSize(card, 200);
    expect(result).toBe(12);
  });
});

// ---------------------------------------------------------------------------
// getCardLabelHeight
// ---------------------------------------------------------------------------
describe('getCardLabelHeight', () => {
  it('uses compact (1-line) budget for short cards', () => {
    // height=56 < 88 → 1 line; 12 * 1.2 * 1 + 3 + 12 = 14.4 + 15 = 29.4 → ceil = 30
    const card = { titleFontSize: 12, height: 56 };
    expect(getCardLabelHeight(card)).toBe(30);
  });

  it('uses 2-line budget for tall cards', () => {
    // height=100 >= 88 → 2 lines; 12 * 1.2 * 2 + 3 + 12 = 28.8 + 15 = 43.8 → ceil = 44
    const card = { titleFontSize: 12, height: 100 };
    expect(getCardLabelHeight(card)).toBe(44);
  });
});

// ---------------------------------------------------------------------------
// nudgeCrowdedPair
// ---------------------------------------------------------------------------
describe('nudgeCrowdedPair', () => {
  function makeCard(top, height) {
    return { top, height, originalTop: top };
  }

  it('does nothing when there is no overlap', () => {
    const top = makeCard(0, 60);
    const bottom = makeCard(200, 60);
    nudgeCrowdedPair(top, bottom);
    expect(top.top).toBe(0);
    expect(bottom.top).toBe(200);
  });

  it('separates an overlapping pair evenly', () => {
    // topCard: top=0 height=60; bottomCard: top=40 height=60
    // overlap = 0+60+4-40 = 24; split 12/12
    const top = makeCard(0, 60);
    const bottom = makeCard(40, 60);
    nudgeCrowdedPair(top, bottom);
    // topCard moves up by min(12, top-topMin)=min(12,0)=0 (can't go below 0-18=-18 but already at 0)
    // Actually topMin = max(0, 0-18) = 0, topMove = min(12, max(0, 0-0)) = 0
    // remaining = 24, bottomMove = min(24, max(0, (40+18)-40)) = min(24, 18) = 18
    expect(top.top).toBe(0);
    expect(bottom.top).toBe(58);
  });

  it('moves topCard up when it has room', () => {
    const top = makeCard(50, 60);
    const bottom = makeCard(80, 60);
    nudgeCrowdedPair(top, bottom);
    // overlap = 50+60+4-80 = 34; topMin=max(0,50-18)=32
    // topMove = min(17, max(0, 50-32)) = min(17,18) = 17
    // remaining = 17; bottomMax = 80+18=98; bottomMove = min(17, max(0,98-80))=min(17,18)=17
    expect(top.top).toBe(33);
    expect(bottom.top).toBe(97);
  });

  it('respects the DENSE_CARD_MAX_NUDGE limit for the top card', () => {
    // topCard at top=10, originalTop=10 → topMin = max(0,10-18)=0, can move at most 10 up
    const top = makeCard(10, 60);
    const bottom = makeCard(20, 60); // overlap = 10+60+4-20 = 54
    nudgeCrowdedPair(top, bottom);
    // topMove = min(27, max(0,10-0)) = min(27,10) = 10 → top.top = 0
    // remaining = 44; bottomMax=20+18=38; bottomMove = min(44, 38-20)=min(44,18)=18
    expect(top.top).toBe(0);
    expect(bottom.top).toBe(38);
  });

  it('respects the DENSE_CARD_MAX_NUDGE limit for the bottom card', () => {
    const top = makeCard(0, 60);
    const bottom = makeCard(10, 60); // overlap = 0+60+4-10 = 54; bottomMax=10+18=28
    nudgeCrowdedPair(top, bottom);
    // topMin=0, topMove=min(27, max(0,0-0))=0
    // remaining=54; bottomMove=min(54,28-10)=min(54,18)=18
    expect(top.top).toBe(0);
    expect(bottom.top).toBe(28);
  });

  it('direction: top card never increases, bottom card never decreases', () => {
    const top = makeCard(20, 80);
    const bottom = makeCard(50, 80);
    const topBefore = top.top;
    const bottomBefore = bottom.top;
    nudgeCrowdedPair(top, bottom);
    expect(top.top).toBeLessThanOrEqual(topBefore);
    expect(bottom.top).toBeGreaterThanOrEqual(bottomBefore);
  });
});

// ---------------------------------------------------------------------------
// getDenseCardZIndex
// ---------------------------------------------------------------------------
describe('getDenseCardZIndex', () => {
  it('returns 1 for non-crowded cards regardless of sentenceCount', () => {
    expect(getDenseCardZIndex({ sentenceCount: 0 }, false)).toBe(1);
    expect(getDenseCardZIndex({ sentenceCount: 100 }, false)).toBe(1);
  });

  it('returns higher z-index for crowded cards with fewer sentences', () => {
    const zFew = getDenseCardZIndex({ sentenceCount: 0 }, true);
    const zMany = getDenseCardZIndex({ sentenceCount: 10 }, true);
    expect(zFew).toBeGreaterThan(zMany);
  });

  it('caps sentenceCount contribution at 10', () => {
    expect(getDenseCardZIndex({ sentenceCount: 10 }, true)).toBe(
      getDenseCardZIndex({ sentenceCount: 100 }, true),
    );
  });

  it('handles missing sentenceCount as 0', () => {
    expect(getDenseCardZIndex({}, true)).toBe(getDenseCardZIndex({ sentenceCount: 0 }, true));
  });

  it('z-index for crowded card with 0 sentences is 30', () => {
    // 20 + max(0, 10 - min(0,10)) = 20 + 10 = 30
    expect(getDenseCardZIndex({ sentenceCount: 0 }, true)).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// adjustCrowdedLevelCards / multi-pass overlap resolution
// ---------------------------------------------------------------------------
describe('adjustCrowdedLevelCards', () => {
  function makeCard(fullPath, top, height, sentenceCount = 5) {
    return { key: fullPath, fullPath, top, height, titleFontSize: 12, sentenceCount };
  }

  it('passes through a single card unchanged (position rounded)', () => {
    const cards = [makeCard('A', 100, 80)];
    const result = adjustCrowdedLevelCards(cards);
    expect(result).toHaveLength(1);
    expect(result[0].top).toBe(100);
    expect(result[0].height).toBe(80);
  });

  it('separates two overlapping cards so they no longer overlap after adjustment', () => {
    // compact height = max(56, 80-16) = 64
    // A: top=0 height=80(→64), B: top=80 height=80(→64)
    // overlap = 0+64+4-80 = -12 → NO overlap after compaction, no nudge needed
    const cards = [makeCard('A', 0, 80), makeCard('B', 80, 80)];
    const result = adjustCrowdedLevelCards(cards);
    expect(result).toHaveLength(2);
    const [r0, r1] = result;
    expect(r0.top + r0.height + DENSE_CARD_GAP).toBeLessThanOrEqual(r1.top + 1); // +1 for rounding
  });

  it('resolves 3 overlapping cards so none remain overlapping', () => {
    // compact height = max(56, 80-16) = 64; cards spaced 80px apart
    // overlaps = 0+64+4-80=-12 → no residual overlap needed, nudge is a no-op
    const cards = [makeCard('A', 0, 80), makeCard('B', 80, 80), makeCard('C', 160, 80)];
    const result = adjustCrowdedLevelCards(cards);
    expect(result).toHaveLength(3);
    for (let i = 0; i < result.length - 1; i += 1) {
      const a = result[i];
      const b = result[i + 1];
      expect(a.top + a.height + DENSE_CARD_GAP).toBeLessThanOrEqual(b.top + 1);
    }
  });

  it('assigns isCrowded=true-based z-index to overlapping cards', () => {
    const cards = [makeCard('A', 50, 80, 0), makeCard('B', 50, 80, 0)];
    const result = adjustCrowdedLevelCards(cards);
    // Crowded with 0 sentences → zIndex = 30
    expect(result[0].zIndex).toBe(30);
    expect(result[1].zIndex).toBe(30);
  });

  it('assigns zIndex=1 to non-crowded cards', () => {
    const cards = [makeCard('A', 0, 60), makeCard('B', 300, 60)]; // far apart
    const result = adjustCrowdedLevelCards(cards);
    expect(result[0].zIndex).toBe(1);
    expect(result[1].zIndex).toBe(1);
  });

  it('reduces overlap even when nudge limits prevent full resolution', () => {
    // Heavy overlap: both start at top=50, height=80 → compact height=64
    // After nudge: A moves from 50→32 (max 18 down), B moves from 50→68 (max 18 up)
    // Residual overlap = 32+64+4-68 = 32 (still overlapping due to limits)
    // but it's much better than the original overlap of 50+64+4-50=68
    const cards = [makeCard('A', 50, 80), makeCard('B', 50, 80)];
    const result = adjustCrowdedLevelCards(cards);
    expect(result).toHaveLength(2);
    const [r0, r1] = result;
    // cards have moved apart compared to original tops
    expect(r0.top).toBeLessThan(50);
    expect(r1.top).toBeGreaterThan(50);
  });

  it('compacts card heights when crowded and height within compact range', () => {
    // height=80 → crowded → max(56, 80-16) = 64
    const cards = [makeCard('A', 50, 80), makeCard('B', 60, 80)];
    const result = adjustCrowdedLevelCards(cards);
    expect(result[0].height).toBeLessThan(80);
    expect(result[0].height).toBeGreaterThanOrEqual(DENSE_CARD_MIN_HEIGHT);
  });

  it('keeps titleFontSize at adjusted value (result of getAdjustedTitleFontSize)', () => {
    const cards = [makeCard('A', 0, 200)];
    const result = adjustCrowdedLevelCards(cards);
    // height=200, not crowded, fontSize=12, cap ≈ (200-31)/2.4 ≈ 70 → 12 wins
    expect(result[0].titleFontSize).toBe(12);
  });

  it('attaches the original sourceCard reference', () => {
    const card = makeCard('A', 0, 80);
    const result = adjustCrowdedLevelCards([card]);
    expect(result[0].sourceCard).toBe(card);
  });
});

// ---------------------------------------------------------------------------
// getAdjustedHierarchyCards
// ---------------------------------------------------------------------------
describe('getAdjustedHierarchyCards', () => {
  function makeCard(fullPath, top, height, levelIndex = 0) {
    return {
      key: fullPath,
      fullPath,
      top,
      height,
      titleFontSize: 12,
      sentenceCount: 5,
      levelIndex,
    };
  }

  it('returns an empty array for empty input', () => {
    expect(getAdjustedHierarchyCards([])).toEqual([]);
  });

  it('processes each level independently', () => {
    // Two cards at different levels with the same vertical position should each
    // be processed in their own column and not affect each other.
    const cards = [makeCard('A', 50, 80, 0), makeCard('B', 50, 80, 1)];
    const result = getAdjustedHierarchyCards(cards);
    expect(result).toHaveLength(2);
  });

  it('returns cards sorted by levelIndex then top then fullPath', () => {
    const cards = [makeCard('Z', 200, 60, 1), makeCard('A', 0, 60, 0), makeCard('M', 100, 60, 1)];
    const result = getAdjustedHierarchyCards(cards);
    expect(result[0].levelIndex).toBeLessThanOrEqual(result[1].levelIndex);
    if (result[1].levelIndex === result[2].levelIndex) {
      expect(result[1].top).toBeLessThanOrEqual(result[2].top);
    }
  });

  it('resolves multi-card overlap within a level column', () => {
    // compact height = max(56, 80-16) = 64; cards spaced 80px apart — no residual overlap
    const cards = [makeCard('A', 0, 80, 0), makeCard('B', 80, 80, 0), makeCard('C', 160, 80, 0)];
    const result = getAdjustedHierarchyCards(cards);
    for (let i = 0; i < result.length - 1; i += 1) {
      const a = result[i];
      const b = result[i + 1];
      if (a.levelIndex === b.levelIndex) {
        expect(a.top + a.height + DENSE_CARD_GAP).toBeLessThanOrEqual(b.top + 1);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// getSummaryFontSizes
// ---------------------------------------------------------------------------
describe('getSummaryFontSizes', () => {
  it('returns base sizes when anchorCard is null', () => {
    const sizes = getSummaryFontSizes(null);
    expect(sizes.kicker).toBe(10);
    expect(sizes.title).toBe(16);
    expect(sizes.text).toBe(14);
  });

  it('returns base sizes when anchorCard is undefined', () => {
    const sizes = getSummaryFontSizes(undefined);
    expect(sizes.kicker).toBe(10);
    expect(sizes.title).toBe(16);
    expect(sizes.text).toBe(14);
  });

  it('returns base sizes when anchorCard.titleFontSize equals BASE_TOPIC_TITLE_FONT_SIZE', () => {
    const sizes = getSummaryFontSizes({ titleFontSize: BASE_TOPIC_TITLE_FONT_SIZE });
    expect(sizes.kicker).toBe(10);
    expect(sizes.title).toBe(16);
    expect(sizes.text).toBe(14);
  });

  it('scales up proportionally when titleFontSize is double the base', () => {
    const sizes = getSummaryFontSizes({ titleFontSize: BASE_TOPIC_TITLE_FONT_SIZE * 2 });
    expect(sizes.kicker).toBe(20);
    expect(sizes.title).toBe(32);
    expect(sizes.text).toBe(28);
    expect(sizes.youtube).toBe(22);
  });

  it('scales the youtube size with the same zoom multiplier', () => {
    expect(getSummaryFontSizes(null).youtube).toBe(11);
    expect(getSummaryFontSizes({ titleFontSize: BASE_TOPIC_TITLE_FONT_SIZE / 2 }).youtube).toBe(11);
  });

  it('does NOT scale down when titleFontSize is smaller than base (multiplier clamped to 1)', () => {
    const sizes = getSummaryFontSizes({ titleFontSize: BASE_TOPIC_TITLE_FONT_SIZE / 2 });
    // zoomMultiplier = max(1, 0.5) = 1
    expect(sizes.kicker).toBe(10);
    expect(sizes.title).toBe(16);
    expect(sizes.text).toBe(14);
  });

  it('falls back to base when anchorCard.titleFontSize is NaN', () => {
    const sizes = getSummaryFontSizes({ titleFontSize: NaN });
    expect(sizes.kicker).toBe(10);
    expect(sizes.title).toBe(16);
    expect(sizes.text).toBe(14);
  });

  it('returns fractional sizes for non-integer multipliers (e.g. 1.5x)', () => {
    const sizes = getSummaryFontSizes({ titleFontSize: BASE_TOPIC_TITLE_FONT_SIZE * 1.5 });
    expect(sizes.kicker).toBeCloseTo(15);
    expect(sizes.title).toBeCloseTo(24);
    expect(sizes.text).toBeCloseTo(21);
  });
});

// ---------------------------------------------------------------------------
// Integration: z-index ordering respects sentenceCount within crowded column
// ---------------------------------------------------------------------------
describe('z-index ordering in a crowded column', () => {
  it('card with fewer sentences gets a higher z-index than one with more', () => {
    const cards = [
      { key: 'A', fullPath: 'A', top: 50, height: 80, titleFontSize: 12, sentenceCount: 1 },
      { key: 'B', fullPath: 'B', top: 55, height: 80, titleFontSize: 12, sentenceCount: 10 },
    ];
    const result = adjustCrowdedLevelCards(cards);
    const cardA = result.find((c) => c.fullPath === 'A');
    const cardB = result.find((c) => c.fullPath === 'B');
    expect(cardA.zIndex).toBeGreaterThan(cardB.zIndex);
  });
});
