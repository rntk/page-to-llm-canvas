import { describe, it, expect } from 'vitest';
import { leavingNodes } from './treeMotion.js';

const node = (key, children = []) => ({ key, children });
const at = (left, top) => ({ left, top, w: 100, h: 40 });

describe('leavingNodes', () => {
  const before = node('root', [node('a', [node('a1'), node('a2', [node('a2x')])]), node('b')]);
  const positions = new Map([
    ['root', at(0, 0)],
    ['a', at(200, -50)],
    ['a1', at(400, -80)],
    ['a2', at(400, -20)],
    ['a2x', at(600, -20)],
    ['b', at(200, 60)],
  ]);

  it('returns nothing when no node disappears', () => {
    expect(leavingNodes(before, before, positions)).toEqual([]);
    expect(leavingNodes(null, before, positions)).toEqual([]);
  });

  it('retreats every node of a folded subtree to its nearest surviving ancestor', () => {
    const after = node('root', [node('a'), node('b')]);
    const result = leavingNodes(before, after, positions);
    expect(result.map((entry) => entry.node.key)).toEqual(['a1', 'a2', 'a2x']);
    result.forEach((entry) => expect(entry.to).toBe(positions.get('a')));
    expect(result[0].from).toBe(positions.get('a1'));
  });

  it('includes the link path of each leaving node', () => {
    const after = node('root', [node('a'), node('b')]);
    const [first] = leavingNodes(before, after, positions);
    expect(first.link).toMatch(/^M/);
  });

  it('skips nodes without a known position', () => {
    const after = node('root', [node('a'), node('b')]);
    const partial = new Map(positions);
    partial.delete('a1');
    expect(leavingNodes(before, after, partial).map((entry) => entry.node.key)).toEqual([
      'a2',
      'a2x',
    ]);
  });
});
