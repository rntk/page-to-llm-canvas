import { describe, it, expect } from 'vitest';
import { clampCardsToParents } from './cardContainment.js';

const MIN = 56;

function makeCard(fullPath, levelIndex, top, height, overrides = {}) {
  return { key: `${fullPath}#${levelIndex}#0`, fullPath, levelIndex, top, height, ...overrides };
}

describe('clampCardsToParents', () => {
  it('returns non-array or empty input unchanged', () => {
    expect(clampCardsToParents([], MIN)).toEqual([]);
    expect(clampCardsToParents(null, MIN)).toBe(null);
  });

  it('leaves a child that already sits inside its parent untouched (same reference)', () => {
    const parent = makeCard('A', 0, 100, 200, { startSentence: 1 });
    const child = makeCard('A > B', 1, 120, 100, { startSentence: 2 });
    const result = clampCardsToParents([parent, child], MIN);
    expect(result[0]).toBe(parent);
    expect(result[1]).toBe(child);
  });

  it('clips a child that extends below its parent', () => {
    const parent = makeCard('A', 0, 112, 78, { startSentence: 5 });
    const child = makeCard('A > B', 1, 112, 108, { startSentence: 5 });
    const [, clamped] = clampCardsToParents([parent, child], MIN);
    expect(clamped).toMatchObject({ top: 112, height: 78 });
  });

  it('clips a child that starts above its parent', () => {
    const parent = makeCard('A', 0, 120, 100, { startSentence: 5 });
    const child = makeCard('A > B', 1, 100, 100, { startSentence: 5 });
    const [, clamped] = clampCardsToParents([parent, child], MIN);
    expect(clamped).toMatchObject({ top: 120, height: 80 });
  });

  it('slides a child up instead of leaving a sliver when little of it is inside the parent', () => {
    const parent = makeCard('A', 0, 112, 78, { startSentence: 5 });
    const child = makeCard('A > B', 1, 170, 72, { startSentence: 5 });
    const [, clamped] = clampCardsToParents([parent, child], MIN);
    expect(clamped.top + clamped.height).toBe(190);
    expect(clamped.height).toBe(MIN);
  });

  it('pins a child measured entirely outside its parent to the nearest parent edge', () => {
    const parent = makeCard('A', 0, 100, 100, { startSentence: 5 });
    const below = makeCard('A > B', 1, 300, 72, { startSentence: 5 });
    const above = makeCard('A > C', 1, 0, 72, { startSentence: 6 });
    const [, b, c] = clampCardsToParents([parent, below, above], MIN);
    expect(b).toMatchObject({ top: 200 - MIN, height: MIN });
    expect(c).toMatchObject({ top: 100, height: MIN });
  });

  it('never grows a child past a parent shorter than the minimum height', () => {
    const parent = makeCard('A', 0, 100, 40, { startSentence: 5 });
    const child = makeCard('A > B', 1, 100, 72, { startSentence: 5 });
    const [, clamped] = clampCardsToParents([parent, child], MIN);
    expect(clamped).toMatchObject({ top: 100, height: 40 });
  });

  it('clamps a grandchild to the already-clamped child', () => {
    const cards = [
      makeCard('A', 0, 100, 80, { startSentence: 1 }),
      makeCard('A > B', 1, 100, 160, { startSentence: 1 }),
      makeCard('A > B > C', 2, 100, 240, { startSentence: 1 }),
    ];
    const [, child, grandchild] = clampCardsToParents(cards, MIN);
    expect(child).toMatchObject({ top: 100, height: 80 });
    expect(grandchild).toMatchObject({ top: 100, height: 80 });
  });

  it('handles levels in any input order', () => {
    const child = makeCard('A > B', 1, 100, 160, { startSentence: 1 });
    const parent = makeCard('A', 0, 100, 80, { startSentence: 1 });
    const result = clampCardsToParents([child, parent], MIN);
    expect(result[0]).toMatchObject({ fullPath: 'A > B', top: 100, height: 80 });
    expect(result[1]).toBe(parent);
  });

  it('picks the parent run that contains the child run when the parent has several', () => {
    const cards = [
      makeCard('A', 0, 0, 100, { key: 'A#0#0', startSentence: 1, endSentence: 3 }),
      makeCard('A', 0, 500, 100, { key: 'A#0#1', startSentence: 10, endSentence: 12 }),
      makeCard('A > B', 1, 500, 200, { startSentence: 11 }),
    ];
    const [, , clamped] = clampCardsToParents(cards, MIN);
    expect(clamped).toMatchObject({ top: 500, height: 100 });
  });

  it('leaves a child alone when no parent run covers its start sentence', () => {
    const cards = [
      makeCard('A', 0, 0, 100, { startSentence: 1, endSentence: 3 }),
      makeCard('A > B', 1, 500, 200, { startSentence: 0 }),
    ];
    const [, child] = clampCardsToParents(cards, MIN);
    expect(child).toBe(cards[1]);
  });

  it('falls back to the sole parent card when sentence positions are missing', () => {
    const cards = [makeCard('A', 0, 0, 100), makeCard('A > B', 1, 0, 200)];
    const [, child] = clampCardsToParents(cards, MIN);
    expect(child).toMatchObject({ top: 0, height: 100 });
  });

  it('does not guess between several parent runs when sentence positions are missing', () => {
    const cards = [
      makeCard('A', 0, 0, 100, { key: 'A#0#0' }),
      makeCard('A', 0, 500, 100, { key: 'A#0#1' }),
      makeCard('A > B', 1, 0, 200),
    ];
    const [, , child] = clampCardsToParents(cards, MIN);
    expect(child).toBe(cards[2]);
  });

  it('ignores cards at the parent level that are not the child’s parent', () => {
    const cards = [
      makeCard('X', 0, 0, 50, { startSentence: 1 }),
      makeCard('A > B', 1, 0, 200, { startSentence: 1 }),
    ];
    const [, child] = clampCardsToParents(cards, MIN);
    expect(child).toBe(cards[1]);
  });
});
