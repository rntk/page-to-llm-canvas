import { describe, it, expect } from 'vitest';
import { gapToSpans, suggestBetterLevel } from './levelHint.js';

describe('gapToSpans', () => {
  const spans = [
    { start: 10, end: 20 },
    { start: 40, end: 50 },
  ];
  it('is 0 inside a span (end exclusive)', () => {
    expect(gapToSpans(spans, 10)).toBe(0);
    expect(gapToSpans(spans, 19.9)).toBe(0);
    expect(gapToSpans(spans, 20)).toBe(0);
  });
  it('measures distance to the nearest span', () => {
    expect(gapToSpans(spans, 5)).toBe(5);
    expect(gapToSpans(spans, 25)).toBe(5);
    expect(gapToSpans(spans, 38)).toBe(2);
    expect(gapToSpans(spans, 60)).toBe(10);
  });
  it('treats a missing end as open-ended', () => {
    expect(gapToSpans([{ start: 10 }], 500)).toBe(0);
  });
  it('returns Infinity without usable input', () => {
    expect(gapToSpans([], 5)).toBe(Infinity);
    expect(gapToSpans(null, 5)).toBe(Infinity);
    expect(gapToSpans(spans, NaN)).toBe(Infinity);
  });
});

describe('suggestBetterLevel', () => {
  it('returns null when the selected level covers the position', () => {
    expect(
      suggestBetterLevel({
        selectedLevel: 1,
        gaps: new Map([
          [0, 0],
          [1, 0],
          [2, 0],
        ]),
      }),
    ).toBeNull();
  });
  it('suggests a covering level when the selected one has a gap', () => {
    expect(
      suggestBetterLevel({
        selectedLevel: 1,
        gaps: new Map([
          [0, 30],
          [1, 12],
          [2, 0],
        ]),
      }),
    ).toBe(2);
  });
  it('prefers the nearest covering level, parent first on ties', () => {
    const gaps = { 0: 0, 1: 9, 2: 9, 3: 0 };
    expect(suggestBetterLevel({ selectedLevel: 1, gaps })).toBe(0);
    expect(suggestBetterLevel({ selectedLevel: 2, gaps })).toBe(3);
    expect(suggestBetterLevel({ selectedLevel: 2, gaps: { 1: 0, 2: 9, 3: 0 } })).toBe(1);
  });
  it('honours the tolerance on both sides', () => {
    expect(suggestBetterLevel({ selectedLevel: 0, gaps: { 0: 4, 1: 0 }, tolerance: 5 })).toBeNull();
    expect(suggestBetterLevel({ selectedLevel: 0, gaps: { 0: 9, 1: 4 }, tolerance: 5 })).toBe(1);
  });
  it('only suggests an uncovered level when it is far closer', () => {
    expect(suggestBetterLevel({ selectedLevel: 0, gaps: { 0: 40, 1: 30 } })).toBeNull();
    expect(suggestBetterLevel({ selectedLevel: 0, gaps: { 0: 40, 1: 10 } })).toBe(1);
  });
  it('needs a covering level when the selected level has no items', () => {
    expect(suggestBetterLevel({ selectedLevel: 0, gaps: { 0: Infinity, 1: 30 } })).toBeNull();
    expect(suggestBetterLevel({ selectedLevel: 0, gaps: { 0: Infinity, 1: 30, 2: 0 } })).toBe(2);
  });
  it('returns null when no level fits or the selected level is unknown', () => {
    expect(suggestBetterLevel({ selectedLevel: 0, gaps: { 0: 10, 1: Infinity } })).toBeNull();
    expect(suggestBetterLevel({ selectedLevel: 3, gaps: { 0: 0 } })).toBeNull();
    expect(suggestBetterLevel({ selectedLevel: 0, gaps: undefined })).toBeNull();
  });
});
