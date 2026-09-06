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

  it('maps the cursor into card space through the scroll offset', () => {
    expect(
      computeSummaryCursorState({
        cards: [{ id: 'nested', box: { top: 300, height: 80 } }],
        bodyTop: 40,
        containerTop: 20,
        containerHeight: 200,
        scrollTop: 230,
      }),
    ).toEqual({ cursorTop: 112, activeCardId: 'nested', relativeY: 302 });
  });

  it('leaves the cursor at rest while there is scrolling left', () => {
    expect(
      computeSummaryCursorState({
        cards,
        bodyTop: 0,
        containerTop: 0,
        containerHeight: 1000,
        remainingScroll: 620,
      }).cursorTop,
    ).toBe(380);
  });

  it('glides the cursor to the viewport bottom as the scroller runs out', () => {
    // A 2000px document in a 1000px viewport: 1000px of scrolling, with the
    // closing summary at 1800-1900 — inside the last viewport-full, so it can
    // never be scrolled up to a cursor resting at 38%.
    const lastCard = { id: 'last', box: { top: 1800, height: 100 } };
    const atBoundary = (remainingScroll) =>
      computeSummaryCursorState({
        cards: [lastCard],
        bodyTop: 0,
        containerTop: 0,
        containerHeight: 1000,
        scrollTop: 1000 - remainingScroll,
        remainingScroll,
      });

    // A cursor pinned at 38% tops out well above the card, whatever the scroll.
    expect(
      computeSummaryCursorState({
        cards: [lastCard],
        bodyTop: 0,
        containerTop: 0,
        containerHeight: 1000,
        scrollTop: 1000,
      }).relativeY,
    ).toBe(1380);

    // Away from the boundary the cursor is still at rest.
    expect(atBoundary(1000).cursorTop).toBe(380);
    // Inside the final stretch it starts descending...
    expect(atBoundary(300).cursorTop).toBe(700);
    // ...far enough that the closing summary does become active...
    expect(atBoundary(50).activeCardId).toBe('last');
    // ...and it ends at the bottom of the viewport, level with the document end.
    expect(atBoundary(0).cursorTop).toBe(1000);
    expect(atBoundary(0).relativeY).toBe(2000);
  });

  it('keeps the cursor at rest in a nested scroller with room left', () => {
    expect(
      computeSummaryCursorState({
        cards,
        bodyTop: 40,
        containerTop: 100,
        containerHeight: 500,
        scrollTop: 0,
        remainingScroll: 400,
      }).cursorTop,
    ).toBe(290);
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
