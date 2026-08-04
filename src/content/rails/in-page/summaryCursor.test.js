import { describe, expect, it } from 'vitest';
import { computeSummaryCursorState } from './summaryCursor.js';

const cards = [
  { id: 'large', box: { top: 100, height: 300 } },
  { id: 'small', box: { top: 150, height: 50 } },
];

describe('computeSummaryCursorState', () => {
  it('uses the minimum cursor top when the viewport ratio is above the body too early', () => {
    expect(
      computeSummaryCursorState({
        cards,
        bodyTop: 0,
        containerTop: 0,
        containerHeight: 100,
      }),
    ).toEqual({ cursorTop: 112, activeCardId: 'large', relativeY: 112 });
  });

  it('chooses the shortest matching card when cards overlap', () => {
    expect(
      computeSummaryCursorState({
        cards,
        bodyTop: 0,
        containerTop: 0,
        containerHeight: 421,
      }),
    ).toEqual({ cursorTop: 160, activeCardId: 'small', relativeY: 160 });
  });

  it('accounts for nested scroll container offset', () => {
    expect(
      computeSummaryCursorState({
        cards: [{ id: 'nested', box: { top: 300, height: 80 } }],
        bodyTop: 40,
        containerTop: 20,
        containerHeight: 200,
        scrollTop: 230,
        isWindowScroll: false,
      }),
    ).toEqual({ cursorTop: 112, activeCardId: 'nested', relativeY: 302 });
  });

  it('clears the active card when there are no cards', () => {
    expect(
      computeSummaryCursorState({
        cards: [],
        bodyTop: 0,
        containerTop: 0,
        containerHeight: 500,
      }),
    ).toEqual({ cursorTop: 112, activeCardId: null, relativeY: 0 });
  });
});
