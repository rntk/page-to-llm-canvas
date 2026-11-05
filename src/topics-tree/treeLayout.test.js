import { describe, it, expect } from 'vitest';
import {
  CARD_MIN,
  boundsOf,
  clampCardSize,
  columnOffsets,
  fitTransform,
  layoutTree,
  treeLinks,
} from './treeLayout.js';

const gaps = { column: 10, sibling: 2, branch: 5 };

const leaf = (key) => ({ key, children: [] });
const node = (key, children) => ({ key, children });

function sizesFor(tree, sizeOf) {
  const sizes = new Map();
  const walk = (n) => {
    sizes.set(n.key, sizeOf(n));
    n.children.forEach(walk);
  };
  walk(tree);
  return sizes;
}

function overlaps(a, b) {
  return (
    a.left < b.left + b.w && b.left < a.left + a.w && a.top < b.top + b.h && b.top < a.top + a.h
  );
}

describe('columnOffsets', () => {
  it('starts each column after the widest node of the previous one', () => {
    expect(columnOffsets([100, 50, 80], 10)).toEqual([0, 110, 170]);
  });
});

describe('layoutTree', () => {
  it('returns an empty map without a tree and null while a node is unmeasured', () => {
    expect(layoutTree(null, new Map()).size).toBe(0);
    const tree = node('r', [leaf('a')]);
    expect(layoutTree(tree, new Map([['r', { w: 1, h: 1 }]]), { gaps })).toBeNull();
  });

  it('stacks siblings with the sibling gap and centres the parent on them', () => {
    const tree = node('r', [leaf('a'), leaf('b'), leaf('c')]);
    const positions = layoutTree(
      tree,
      sizesFor(tree, () => ({ w: 20, h: 10 })),
      { gaps },
    );
    const [a, b, c] = ['a', 'b', 'c'].map((key) => positions.get(key));
    expect(a.left).toBe(30);
    expect(b.top - (a.top + a.h)).toBe(2);
    expect(c.top - (b.top + b.h)).toBe(2);
    const root = positions.get('r');
    expect(root.top + root.h / 2).toBe(b.top + b.h / 2);
  });

  it('separates cousins with the branch gap and never overlaps nodes', () => {
    const tree = node('r', [
      node('a', [leaf('a1'), leaf('a2')]),
      node('b', [leaf('b1'), node('b2', [leaf('b2x'), leaf('b2y'), leaf('b2z')])]),
      leaf('c'),
    ]);
    const heights = { a: 60, b2: 4, c: 30 };
    const positions = layoutTree(
      tree,
      sizesFor(tree, (n) => ({ w: 10 + n.key.length * 10, h: heights[n.key] ?? 10 })),
      { gaps },
    );
    const rects = [...positions.values()];
    for (let i = 0; i < rects.length; i += 1) {
      for (let j = i + 1; j < rects.length; j += 1) {
        expect(overlaps(rects[i], rects[j])).toBe(false);
      }
    }
    const a2 = positions.get('a2');
    const b1 = positions.get('b1');
    expect(b1.top - (a2.top + a2.h)).toBeGreaterThanOrEqual(5);
    // Columns are laid out by depth.
    expect(positions.get('a').left).toBe(positions.get('b').left);
    expect(positions.get('b2x').left).toBeGreaterThan(positions.get('b1').left);
  });

  it('applies manual offsets to the moved node only', () => {
    const tree = node('r', [leaf('a'), leaf('b')]);
    const sizes = sizesFor(tree, () => ({ w: 20, h: 10 }));
    const base = layoutTree(tree, sizes, { gaps });
    const moved = layoutTree(tree, sizes, { gaps, offsets: new Map([['a', { dx: 5, dy: -3 }]]) });
    expect(moved.get('a')).toEqual({
      ...base.get('a'),
      left: base.get('a').left + 5,
      top: base.get('a').top - 3,
    });
    expect(moved.get('b')).toEqual(base.get('b'));
  });
});

describe('treeLinks', () => {
  it('draws a horizontal link per edge, anchoring cards at their header', () => {
    const tree = node('r', [leaf('a')]);
    const positions = new Map([
      ['r', { left: 0, top: 0, w: 100, h: 20 }],
      ['a', { left: 200, top: 50, w: 100, h: 300 }],
    ]);
    expect(treeLinks(tree, positions)).toEqual([{ key: 'a', d: 'M104,10C150,10 150,200 196,200' }]);
    expect(treeLinks(tree, positions, () => true)[0].d).toBe('M104,10C150,10 150,70 196,70');
  });
});

describe('geometry helpers', () => {
  it('clamps card sizes to a readable minimum', () => {
    expect(clampCardSize(10, 10)).toEqual(CARD_MIN);
    expect(clampCardSize(400.4, 300.6)).toEqual({ w: 400, h: 301 });
  });

  it('computes bounds of rectangles', () => {
    expect(boundsOf([])).toBeNull();
    expect(
      boundsOf([
        { left: 10, top: 5, w: 10, h: 10 },
        { left: -5, top: 20, w: 5, h: 5 },
      ]),
    ).toEqual({ minX: -5, minY: 5, width: 25, height: 20 });
  });

  it('fits bounds without enlarging past 1:1', () => {
    const viewport = { width: 1000, height: 600 };
    expect(fitTransform(null, viewport)).toEqual({ k: 1, x: 24, y: 300 });
    expect(fitTransform({ minX: 0, minY: 0, width: 100, height: 100 }, viewport)).toEqual({
      k: 1,
      x: 450,
      y: 250,
    });
    const big = fitTransform({ minX: 0, minY: 0, width: 4000, height: 200 }, viewport);
    expect(big.k).toBeCloseTo(952 / 4000);
  });
});
