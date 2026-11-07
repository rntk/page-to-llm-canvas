import { describe, expect, it } from 'vitest';
import {
  CARD_GAP,
  CARD_HEIGHT,
  CARD_WIDTH,
  EXCERPT_GAP,
  EXCERPT_HEIGHT,
  EXCERPT_INDENT,
  excerptConnectorPath,
  layoutGrid,
  layoutProjectCanvas,
} from './canvasLayout.js';

describe('layoutProjectCanvas', () => {
  it('matches the plain grid when there are no excerpts', () => {
    const { pages, excerpts } = layoutProjectCanvas([1, 2, 3, 4], {});
    expect(pages).toEqual(layoutGrid([1, 2, 3, 4]));
    expect(excerpts).toEqual({});
  });

  it('stacks excerpts under their page and pushes the next row down', () => {
    const { pages, excerpts } = layoutProjectCanvas([1, 2, 3], { 1: ['e1', 'e2'] });
    expect(excerpts.e1).toEqual({
      page: 1,
      dx: EXCERPT_INDENT,
      dy: CARD_HEIGHT + EXCERPT_GAP,
      x: EXCERPT_INDENT,
      y: CARD_HEIGHT + EXCERPT_GAP,
    });
    expect(excerpts.e2.dy).toBe(CARD_HEIGHT + EXCERPT_GAP + EXCERPT_HEIGHT + EXCERPT_GAP);
    const stack = CARD_HEIGHT + 2 * (EXCERPT_HEIGHT + EXCERPT_GAP);
    expect(pages[3]).toEqual({ x: 0, y: stack + CARD_GAP });
  });

  it('puts excerpts without a page card in one trailing slot', () => {
    const { pages, excerpts } = layoutProjectCanvas([1], {}, ['o1', 'o2']);
    expect(pages[1]).toEqual({ x: 0, y: 0 });
    expect(excerpts.o1).toMatchObject({ page: null, x: CARD_WIDTH + CARD_GAP, y: 0 });
    expect(excerpts.o2.y).toBe(EXCERPT_HEIGHT + EXCERPT_GAP);
  });
});

describe('excerptConnectorPath', () => {
  it('draws an elbow to an excerpt in its stack', () => {
    const page = { x: 0, y: 0 };
    const excerpt = { x: EXCERPT_INDENT, y: CARD_HEIGHT + EXCERPT_GAP };
    expect(excerptConnectorPath(page, excerpt)).toBe(
      `M ${EXCERPT_INDENT / 2} ${CARD_HEIGHT} V ${excerpt.y + EXCERPT_HEIGHT / 2} H ${EXCERPT_INDENT}`,
    );
  });

  it('curves to an excerpt dragged elsewhere', () => {
    expect(excerptConnectorPath({ x: 0, y: 0 }, { x: 900, y: -300 })).toMatch(/^M .* C /);
  });
});
