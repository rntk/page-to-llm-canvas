import { describe, it, expect } from 'vitest';
import { buildTopicTree, collectNonLeafPaths, countLeafDescendants } from './topicTree.js';

describe('buildTopicTree', () => {
  it('returns empty array for null input', () => {
    expect(buildTopicTree(null)).toEqual([]);
  });

  it('returns empty array for undefined input', () => {
    expect(buildTopicTree(undefined)).toEqual([]);
  });

  it('returns empty array for non-array input', () => {
    expect(buildTopicTree('not an array')).toEqual([]);
  });

  it('returns empty array for empty array input', () => {
    expect(buildTopicTree([])).toEqual([]);
  });

  it('builds a single root node from a flat topic', () => {
    const topics = [{ name: 'Tech', sentences: [0, 1, 2] }];
    const tree = buildTopicTree(topics);
    expect(tree).toHaveLength(1);
    expect(tree[0].node.name).toBe('Tech');
    expect(tree[0].node.fullPath).toBe('Tech');
    expect(tree[0].node.depth).toBe(0);
    expect(tree[0].node.topic).toEqual(topics[0]);
  });

  it('builds a two-level hierarchy from A > B', () => {
    const topics = [{ name: 'Tech > AI', sentences: [0, 1] }];
    const tree = buildTopicTree(topics);
    expect(tree).toHaveLength(1);
    expect(tree[0].node.name).toBe('Tech');
    expect(tree[0].node.topic).toBeNull();
    const children = Array.from(tree[0].children.values());
    expect(children).toHaveLength(1);
    expect(children[0].node.name).toBe('AI');
    expect(children[0].node.fullPath).toBe('Tech>AI');
    expect(children[0].node.topic).toEqual(topics[0]);
  });

  it('builds a three-level hierarchy from A > B > C', () => {
    const topics = [{ name: 'Tech > AI > Models', sentences: [0, 1] }];
    const tree = buildTopicTree(topics);
    expect(tree).toHaveLength(1);
    expect(tree[0].node.name).toBe('Tech');
    const mid = Array.from(tree[0].children.values())[0];
    expect(mid.node.name).toBe('AI');
    expect(mid.node.fullPath).toBe('Tech>AI');
    const leaf = Array.from(mid.children.values())[0];
    expect(leaf.node.name).toBe('Models');
    expect(leaf.node.fullPath).toBe('Tech>AI>Models');
    expect(leaf.node.topic).toEqual(topics[0]);
  });

  it('creates multiple root nodes for different top-level topics', () => {
    const topics = [
      { name: 'Tech', sentences: [0, 1] },
      { name: 'Science', sentences: [2, 3] },
    ];
    const tree = buildTopicTree(topics);
    expect(tree).toHaveLength(2);
    const names = tree.map((e) => e.node.name).sort();
    expect(names).toEqual(['Science', 'Tech']);
  });

  it('reuses existing nodes when multiple topics share a path prefix', () => {
    const topics = [
      { name: 'Tech > AI', sentences: [0, 1] },
      { name: 'Tech > Web', sentences: [2, 3] },
    ];
    const tree = buildTopicTree(topics);
    expect(tree).toHaveLength(1);
    expect(tree[0].node.name).toBe('Tech');
    const children = Array.from(tree[0].children.values());
    expect(children).toHaveLength(2);
    const childNames = children.map((c) => c.node.name).sort();
    expect(childNames).toEqual(['AI', 'Web']);
  });

  it('precomputes leaf counts for each tree entry', () => {
    const topics = [
      { name: 'Tech > AI', sentences: [0, 1] },
      { name: 'Tech > Web', sentences: [2, 3] },
      { name: 'Science', sentences: [4] },
    ];
    const tree = buildTopicTree(topics);
    const tech = tree.find((entry) => entry.node.name === 'Tech');
    const science = tree.find((entry) => entry.node.name === 'Science');
    const techChildren = Array.from(tech.children.values());

    expect(tech.leafCount).toBe(2);
    expect(techChildren.every((entry) => entry.leafCount === 1)).toBe(true);
    expect(science.leafCount).toBe(1);
  });

  it('assigns the topic only to the deepest node', () => {
    const topics = [{ name: 'A > B > C', sentences: [5] }];
    const tree = buildTopicTree(topics);
    expect(tree[0].node.topic).toBeNull();
    const bNode = Array.from(tree[0].children.values())[0];
    expect(bNode.node.topic).toBeNull();
    const cNode = Array.from(bNode.children.values())[0];
    expect(cNode.node.topic).toEqual(topics[0]);
  });

  it('handles spaces around separators', () => {
    const topics = [{ name: ' Tech  >  AI ', sentences: [0] }];
    const tree = buildTopicTree(topics);
    expect(tree).toHaveLength(1);
    expect(tree[0].node.name).toBe('Tech');
    const child = Array.from(tree[0].children.values())[0];
    expect(child.node.name).toBe('AI');
  });

  it('skips topics with empty names', () => {
    const topics = [
      { name: '', sentences: [0] },
      { name: 'Valid', sentences: [1] },
    ];
    const tree = buildTopicTree(topics);
    expect(tree).toHaveLength(1);
    expect(tree[0].node.name).toBe('Valid');
  });

  it('respects startDepth parameter', () => {
    const topics = [{ name: 'A > B > C', sentences: [0] }];
    const tree = buildTopicTree(topics, 1);
    expect(tree).toHaveLength(1);
    expect(tree[0].node.name).toBe('B');
    expect(tree[0].node.fullPath).toBe('A>B');
  });

  it('sets parent references correctly', () => {
    const topics = [{ name: 'A > B', sentences: [0] }];
    const tree = buildTopicTree(topics);
    const root = tree[0];
    expect(root.parent).toBeNull();
    const child = Array.from(root.children.values())[0];
    expect(child.parent).toBe(root);
  });
});

describe('collectNonLeafPaths', () => {
  const topics = [
    { name: 'Fruit > Citrus > Orange' },
    { name: 'Fruit > Citrus > Lemon' },
    { name: 'Fruit > Berry' },
    { name: 'Veggie' },
  ];

  it('returns every branch path in pre-order with no minDepth', () => {
    const roots = buildTopicTree(topics, 0);
    expect(collectNonLeafPaths(roots)).toEqual(['Fruit', 'Fruit>Citrus']);
  });

  it('restricts to branches at or below minDepth', () => {
    const roots = buildTopicTree(topics, 0);
    expect(collectNonLeafPaths(roots, { minDepth: 1 })).toEqual(['Fruit>Citrus']);
  });

  it('returns no paths when minDepth is deeper than any branch', () => {
    const roots = buildTopicTree(topics, 0);
    expect(collectNonLeafPaths(roots, { minDepth: 2 })).toEqual([]);
  });

  it('handles a nullish roots argument', () => {
    expect(collectNonLeafPaths(null)).toEqual([]);
  });
});

describe('countLeafDescendants', () => {
  it('returns 1 for a leaf node with no children', () => {
    const entry = { children: new Map() };
    expect(countLeafDescendants(entry)).toBe(1);
  });

  it('returns 2 for a branch with two leaves', () => {
    const leaf1 = { children: new Map() };
    const leaf2 = { children: new Map() };
    const branch = {
      children: new Map([
        ['a', leaf1],
        ['b', leaf2],
      ]),
    };
    expect(countLeafDescendants(branch)).toBe(2);
  });

  it('counts leaves in a deep hierarchy', () => {
    const leaf1 = { children: new Map() };
    const leaf2 = { children: new Map() };
    const leaf3 = { children: new Map() };
    const mid = {
      children: new Map([
        ['x', leaf1],
        ['y', leaf2],
      ]),
    };
    const root = {
      children: new Map([
        ['a', mid],
        ['b', leaf3],
      ]),
    };
    expect(countLeafDescendants(root)).toBe(3);
  });
});
