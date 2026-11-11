import { describe, it, expect } from 'vitest';
import {
  LEAF_KIND,
  ROOT_KEY,
  ROOT_KIND,
  TOPIC_KIND,
  buildTopicsDisplayTree,
  buildSummaryTreeDisplayTree,
  groupSentenceSources,
  textKey,
} from './displayTree.js';
import {
  currentLevel,
  expandAll,
  expandBranch,
  expandToLevel,
  flattenTree,
  initialExpanded,
  pathTo,
  revealNode,
  toggleText,
  toggleNode,
  treeDepth,
  visibleTree,
} from './expansion.js';
import { labelSize } from './labelMetrics.js';

describe('groupSentenceSources', () => {
  it('keeps overlapping article-local sentence ids in distinct source groups', () => {
    const a = { recordKey: 'a', title: 'First article', url: 'https://same.test/a', sentenceId: 1 };
    const b = {
      recordKey: 'b',
      title: 'Second article',
      url: 'https://same.test/b',
      sentenceId: 1,
    };
    expect(groupSentenceSources([1, 3, 2], { 1: a, 2: { ...a, sentenceId: 9 }, 3: b })).toEqual([
      {
        id: 'a',
        source: a,
        sentences: [
          { number: 1, sourceNumber: 1 },
          { number: 2, sourceNumber: 9 },
        ],
      },
      { id: 'b', source: b, sentences: [{ number: 3, sourceNumber: 1 }] },
    ]);
  });

  it('keeps regular article numbering and does not borrow identity for unmapped rows', () => {
    expect(groupSentenceSources([2, 8])).toEqual([
      {
        id: 'article',
        source: null,
        sentences: [
          { number: 2, sourceNumber: 2 },
          { number: 8, sourceNumber: 8 },
        ],
      },
    ]);
    expect(groupSentenceSources([7], {})).toEqual([
      {
        id: 'unknown',
        source: { title: 'Unknown source' },
        sentences: [{ number: 7, sourceNumber: null }],
      },
    ]);
  });
});

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

describe('reused summary disclosure', () => {
  it('folds the primary-topic duplicate in Business > Risk > Balance Sheet Business', () => {
    const summary =
      'OpenAI and Anthropic plan gigawatt‑scale chip data centers, debt‑free now but may take debt, targeting five gigawatts by year end.';
    const tree = buildTopicsDisplayTree(
      [{ name: 'Business>Risk>Balance Sheet Business', sentences: [1686, 1687] }],
      {
        Business: { runs: [{ text: 'A distinct business overview.' }] },
        'Business>Risk': { runs: [{ text: summary }] },
        'Business>Risk>Balance Sheet Business': { runs: [{ text: summary }] },
      },
    );
    const [business, risk, balanceSheet, source] = flattenTree(tree).slice(1);
    expect(business.summarySameAsParent).toBe(false);
    expect(risk.summarySameAsParent).toBe(false);
    expect(balanceSheet.summarySameAsParent).toBe(true);
    expect(balanceSheet.summary).toBe(summary);
    expect(source.kind).toBe(LEAF_KIND);
  });

  it('keeps primary summaries visible when there are siblings or additional parent source text', () => {
    const paths = ['Business>Risk', 'Business>Risk>Balance Sheet Business', 'Business>Other'];
    const tree = buildTopicsDisplayTree(
      paths.map((name, i) => ({ name, sentences: [i + 1] })),
      Object.fromEntries(
        ['Business', ...paths].map((path) => [path, { runs: [{ text: 'Same prose.' }] }]),
      ),
    );
    expect(flattenTree(tree).filter((n) => n.summarySameAsParent)).toEqual([]);
  });

  it('marks only matching prose across single-child edges, including chains in saved trees', () => {
    const node = (id, children, text) => ({
      id,
      title: id,
      kind: 'topic',
      children,
      sentences: [1],
      segments: [{ text }],
    });
    const tree = buildSummaryTreeDisplayTree({
      rootId: 'r',
      nodes: {
        r: node('r', ['a'], 'Shared summary.'),
        a: node('a', ['b'], 'Shared  summary.'),
        b: node('b', ['c', 'd'], 'Shared summary.'),
        c: node('c', ['e'], 'Shared summary.'),
        d: node('d', [], ''),
        e: node('e', [], 'A distinct summary.'),
      },
    });
    expect(flattenTree(tree).map((n) => n.summarySameAsParent)).toEqual([
      false,
      true,
      true,
      false,
      false,
      false,
    ]);
  });
});

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
      kind: TOPIC_KIND,
      depth: 2,
      summary: 'Apples are red.',
      sentences: [1, 3],
    });
    expect(fruit.children[0].children).toEqual([
      expect.objectContaining({
        key: 'source:Fruit>Apples',
        kind: LEAF_KIND,
        title: 'Source',
        depth: 3,
        sentences: [1, 3],
        children: [],
      }),
    ]);
    expect(veg.children.map((child) => child.kind)).toEqual([TOPIC_KIND, TOPIC_KIND]);
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

  it('ignores source leaves when toggling', () => {
    const tree = build();
    const expanded = initialExpanded(tree);
    expect(toggleNode(tree, expanded, 'source:Fruit>Apples')).toEqual(expanded);
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
    expect(treeDepth(tree)).toBe(5);
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
    expect([...branch].sort()).toEqual(
      [ROOT_KEY, key('Veg'), key('Veg>Roots'), key('Veg>Roots>Carrots'), key('Veg>Leaves')].sort(),
    );
    expect([...revealNode(tree, new Set(), key('Veg>Roots>Carrots'))].sort()).toEqual(
      [ROOT_KEY, key('Veg'), key('Veg>Roots')].sort(),
    );
    expect(expandAll(tree).size).toBe(8);
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
    expect(labelSize(fruit.children[0].children[0], 6)).toBe(14);
    expect(labelSize(fruit, 0)).toBe(15);
  });
});

describe('source text blocks', () => {
  const topics = [
    { name: 'Fruit>Apples', sentences: [1, 2] },
    { name: 'Fruit>Pears', sentences: [2, 3] },
    { name: 'Veg', sentences: [4] },
  ];
  const build = () => buildTopicsDisplayTree(topics, null, { title: 'site' });

  it('gives branches with sub-topics a text block with one section per source card', () => {
    const tree = build();
    const fruit = tree.children[0];
    expect(fruit.textCard).toMatchObject({
      key: 'text:topic:Fruit',
      kind: LEAF_KIND,
      path: 'Fruit',
      depth: fruit.depth + 1,
      sentences: [1, 2, 3],
    });
    expect(fruit.textCard.sections.map((s) => [s.path, s.sentences])).toEqual([
      ['Fruit>Apples', [1, 2]],
      ['Fruit>Pears', [2, 3]],
    ]);
    expect(tree.textCard.sentences).toEqual([1, 2, 3, 4]);
    expect(tree.textCard.sections).toHaveLength(3);
    // A branch whose only child is its own source card needs none.
    expect(fruit.children[0].textCard).toBeUndefined();
    expect(tree.children[1].textCard).toBeUndefined();
    expect(pathTo(tree, 'text:topic:Fruit').map((node) => node.key)).toEqual([
      ROOT_KEY,
      'topic:Fruit',
      'text:topic:Fruit',
    ]);
  });

  it('shows the block in place of the child branches and folds back', () => {
    const tree = build();
    const open = toggleText(tree, expandBranch(tree, new Set(), 'topic:Fruit'), 'topic:Fruit');
    expect(open.has('topic:Fruit')).toBe(false);
    expect(open.has(textKey('topic:Fruit'))).toBe(true);
    expect(open.has(ROOT_KEY)).toBe(true);
    const shown = visibleTree(tree, open).children[0];
    expect(shown.children.map((child) => child.key)).toEqual(['text:topic:Fruit']);

    expect(toggleText(tree, open, 'topic:Fruit').has(textKey('topic:Fruit'))).toBe(false);
    expect(toggleNode(tree, open, 'topic:Fruit').has(textKey('topic:Fruit'))).toBe(false);
    // Unfolding the branch instead drops the text.
    expect(expandBranch(tree, open, 'topic:Fruit').has(textKey('topic:Fruit'))).toBe(false);
    // Nodes without a block are left alone.
    expect(toggleText(tree, new Set([ROOT_KEY]), 'topic:Veg')).toEqual(new Set([ROOT_KEY]));
  });

  it('is also attached to summary trees', () => {
    const tree = buildSummaryTreeDisplayTree({
      rootId: 'r',
      nodes: {
        r: { id: 'r', title: 'r', kind: 'topic', children: ['a', 'b'], sentences: [1, 2] },
        a: { id: 'a', title: 'a', kind: 'passage', children: [], sentences: [1] },
        b: { id: 'b', title: 'b', kind: 'passage', children: [], sentences: [2] },
      },
    });
    expect(tree.textCard.sections.map((section) => section.sentences)).toEqual([[1], [2]]);
  });
});

describe('summary tree display sources', () => {
  it('counts distinct source records per node and sorts source sentence numbers', () => {
    const tree = buildSummaryTreeDisplayTree({
      rootId: 'root',
      nodes: {
        root: {
          id: 'root',
          title: 'Overview',
          kind: 'root',
          children: ['a', 'b'],
          sentences: [3, 1, 2, 1],
        },
        a: { id: 'a', title: 'A', kind: 'passage', children: [], sentences: [3, 1, 3] },
        b: { id: 'b', title: 'B', kind: 'passage', children: [], sentences: [2] },
      },
      sources: {
        1: { recordKey: 'article-a' },
        2: { recordKey: 'article-b' },
        3: { recordKey: 'article-a' },
      },
    });

    expect(tree.sentences).toEqual([1, 2, 3]);
    expect(tree.sourceCount).toBe(2);
    expect(tree.children.map((node) => [node.sentences, node.sourceCount])).toEqual([
      [[1, 3], 1],
      [[2], 1],
    ]);
    expect(tree.children[0].children[0].sentences).toEqual([1, 3]);
  });

  it('ignores dangling child ids and reports zero when no sentence has a source record', () => {
    const tree = buildSummaryTreeDisplayTree({
      rootId: 'root',
      nodes: {
        root: {
          id: 'root',
          title: 'Overview',
          kind: 'root',
          children: ['missing', 'p'],
          sentences: [5],
        },
        p: { id: 'p', title: 'Passage', kind: 'passage', children: [], sentences: [5] },
      },
      sources: { 5: { title: 'Unattributed' } },
    });

    expect(tree.children.map((node) => node.title)).toEqual(['Passage']);
    expect(tree.sourceCount).toBe(0);
    expect(tree.children[0].children[0]).toMatchObject({
      key: 'source:p',
      path: 'Passage',
      sentences: [5],
    });
  });
});
