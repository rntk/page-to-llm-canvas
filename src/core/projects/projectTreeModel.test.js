import { describe, expect, it } from 'vitest';
import { createTreeModel } from './projectTreeModel.js';

const tree = {
  title: 'Research',
  rootId: 'root',
  records: [{ key: 'a', title: 'Shared', url: 'https://a.test' }],
  sentences: ['  Solar panels lower costs. ', 'Wind farms generate power.'],
  sources: {
    1: { recordKey: 'a', sentenceId: 4 },
    2: { recordKey: 'b', sentenceId: 1, title: 'Shared', url: 'https://b.test' },
  },
  nodes: {
    root: { id: 'root', kind: 'root', title: 'Research', children: ['topic'], sentences: [1, 2] },
    topic: {
      id: 'topic',
      kind: 'topic',
      title: 'Energy',
      children: ['passage'],
      sentences: [1, 2],
    },
    passage: { id: 'passage', kind: 'passage', title: 'Solar', sentences: [1, 2] },
    detached: { id: 'detached', kind: 'topic', title: 'Detached', children: [], sentences: [2] },
  },
};

describe('createTreeModel', () => {
  it('returns null for snapshots without nodes', () => {
    expect(createTreeModel(null)).toBeNull();
    expect(createTreeModel({ nodes: {} })).toBeNull();
  });

  it('resolves reachable evidence and preserves explicit membership', () => {
    const model = createTreeModel(tree);
    expect(model.reachable().map((node) => node.id)).toEqual(['root', 'topic', 'passage']);
    expect(model.sentenceIds(model.getNode('topic'))).toEqual([1, 2]);
    expect(model.cite(1)).toMatchObject({
      id: 1,
      line: 4,
      text: 'Solar panels lower costs.',
      article: { key: 'a' },
    });
    expect(model.articles.map((article) => article.key)).toEqual(['a']);
    expect(model.articles[0].label).toBe('Shared');
    expect(model.pathTitles(model.getNode('passage'))).toEqual(['Energy', 'Solar']);
    expect(model.isLeaf(model.getNode('passage'))).toBe(true);
    expect(model.getNode('topic')).toBe(tree.nodes.topic);
    expect(() => model.getNode('missing')).toThrow(/Unknown node_id/);
  });

  it('creates a virtual root for unfinished snapshots and derives membership from reachable evidence', () => {
    const model = createTreeModel({
      title: 'Draft',
      sentences: ['Evidence.'],
      sources: { 1: { url: 'https://one.test', title: 'One' } },
      nodes: {
        topic: { id: 'topic', kind: 'topic', title: 'Loose', children: [], sentences: [1] },
      },
    });
    expect(model.root).toMatchObject({ id: 'root', title: 'Draft', children: ['topic'] });
    expect(model.reachable().map((node) => node.id)).toEqual(['topic']);
    expect(model.articles.map((article) => article.title)).toEqual(['One']);
  });
});
