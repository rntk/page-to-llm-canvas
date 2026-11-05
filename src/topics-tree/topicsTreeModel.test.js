import { describe, it, expect } from 'vitest';
import {
  LEAF_KIND,
  ROOT_KEY,
  ROOT_KIND,
  TOPIC_KIND,
  buildTopicsDisplayTree,
  currentLevel,
  expandAll,
  expandBranch,
  expandToLevel,
  flattenTree,
  initialExpanded,
  labelSize,
  pathTo,
  revealNode,
  toggleNode,
  treeDepth,
  visibleTree,
} from './topicsTreeModel.js';

const topics = [
  { name: 'Fruit>Apples', sentences: [3, 1] },
  { name: 'Fruit>Pears', sentences: [2] },
  { name: 'Veg>Roots>Carrots', sentences: [5] },
  { name: 'Veg>Leaves', sentences: [4, 6] },
];

const summaries = {
  Fruit: { level: 0, runs: [{ text: 'All about fruit.', sentences: [1, 2, 3] }] },
  'Fruit>Apples': { level: 1, runs: [{ text: 'Apples are', sentences: [1] }, { text: 'red.' }] },
};

const key = (path) => `topic:${path}`;

function build() {
  return buildTopicsDisplayTree(topics, summaries, { title: 'example.com' });
}

describe('buildTopicsDisplayTree', () => {
  it('returns null without topics', () => {
    expect(buildTopicsDisplayTree([], summaries)).toBeNull();
    expect(buildTopicsDisplayTree(null, null)).toBeNull();
  });

  it('builds a virtual root over the aggregated topic hierarchy', () => {
    const tree = build();
    expect(tree).toMatchObject({ key: ROOT_KEY, kind: ROOT_KIND, title: 'example.com', depth: 0 });
    expect(tree.children.map((child) => child.title)).toEqual(['Fruit', 'Veg']);
    expect(tree.sentences).toEqual([1, 2, 3, 4, 5, 6]);

    const [fruit, veg] = tree.children;
    expect(fruit).toMatchObject({
      key: key('Fruit'),
      kind: TOPIC_KIND,
      path: 'Fruit',
      depth: 1,
      summary: 'All about fruit.',
      sentences: [1, 2, 3],
    });
    expect(fruit.children[0]).toMatchObject({
      key: key('Fruit>Apples'),
      kind: LEAF_KIND,
      depth: 2,
      summary: 'Apples are red.',
      sentences: [1, 3],
    });
    expect(veg.children.map((child) => child.kind)).toEqual([TOPIC_KIND, LEAF_KIND]);
    expect(veg.children[0].children[0]).toMatchObject({ title: 'Carrots', depth: 3 });
  });
});

describe('expansion helpers', () => {
  it('starts with only the root open', () => {
    const tree = build();
    const expanded = initialExpanded(tree);
    expect([...expanded]).toEqual([ROOT_KEY]);
    expect(flattenTree(visibleTree(tree, expanded)).map((n) => n.title)).toEqual([
      'example.com',
      'Fruit',
      'Veg',
    ]);
    expect(initialExpanded(null).size).toBe(0);
  });

  it('marks how many children a collapsed node hides', () => {
    const visible = visibleTree(build(), initialExpanded(build()));
    expect(visible.hiddenCount).toBe(0);
    expect(visible.children.map((child) => child.hiddenCount)).toEqual([2, 2]);
  });

  it('finds the path from the root to a node', () => {
    const tree = build();
    expect(pathTo(tree, key('Veg>Roots>Carrots')).map((n) => n.title)).toEqual([
      'example.com',
      'Veg',
      'Roots',
      'Carrots',
    ]);
    expect(pathTo(tree, 'missing')).toEqual([]);
  });

  it('toggles a node open and closed, collapsing its descendants', () => {
    const tree = build();
    let expanded = toggleNode(tree, initialExpanded(tree), key('Veg'));
    expanded = toggleNode(tree, expanded, key('Veg>Roots'));
    expect(expanded.has(key('Veg>Roots'))).toBe(true);
    expanded = toggleNode(tree, expanded, key('Veg'));
    expect(expanded.has(key('Veg'))).toBe(false);
    expect(expanded.has(key('Veg>Roots'))).toBe(false);
  });

  it('ignores leaves when toggling', () => {
    const tree = build();
    const expanded = initialExpanded(tree);
    expect(toggleNode(tree, expanded, key('Fruit>Apples'))).toEqual(expanded);
  });

  it('closes sibling branches in exclusive mode', () => {
    const tree = build();
    let expanded = toggleNode(tree, initialExpanded(tree), key('Fruit'), true);
    expanded = toggleNode(tree, expanded, key('Veg'), true);
    expect(expanded.has(key('Fruit'))).toBe(false);
    expect(expanded.has(key('Veg'))).toBe(true);
  });

  it('expands to a given level and recognises it again', () => {
    const tree = build();
    expect(treeDepth(tree)).toBe(4);
    const level2 = expandToLevel(tree, 2);
    expect([...level2]).toEqual([ROOT_KEY]);
    const level3 = expandToLevel(tree, 3);
    expect([...level3].sort()).toEqual([ROOT_KEY, key('Fruit'), key('Veg')].sort());
    expect(currentLevel(tree, level3)).toBe(3);
    expect(currentLevel(tree, new Set([ROOT_KEY, key('Fruit')]))).toBeNull();
  });

  it('expands a whole branch, its ancestors, and everything', () => {
    const tree = build();
    const branch = expandBranch(tree, new Set(), key('Veg'));
    expect([...branch].sort()).toEqual([ROOT_KEY, key('Veg'), key('Veg>Roots')].sort());
    expect([...revealNode(tree, new Set(), key('Veg>Roots>Carrots'))].sort()).toEqual(
      [ROOT_KEY, key('Veg'), key('Veg>Roots')].sort(),
    );
    expect(expandAll(tree).size).toBe(4);
    expect(expandAll(null).size).toBe(0);
  });
});

describe('labelSize', () => {
  it('grows with the share of sentences a topic covers', () => {
    const tree = build();
    const [fruit] = tree.children;
    expect(labelSize(tree, 6)).toBe(36);
    expect(labelSize(fruit, 6)).toBeLessThan(36);
    expect(labelSize(fruit, 6)).toBeGreaterThan(15);
    expect(labelSize(fruit.children[0], 6)).toBe(14);
    expect(labelSize(fruit, 0)).toBe(15);
  });
});
