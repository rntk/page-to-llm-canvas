import { describe, expect, it } from 'vitest';
import { projectSummaryTreeTopics } from './summaryTreeTopicProjection.js';
import { buildTopicTree } from './topicTree.js';
import { buildTopicHierarchyTree, flattenTopicHierarchy } from './topicDomain.js';
import { buildSummaryCards, selectCurrentTopicSummary } from './summaryCards.js';

const text = (value) => [{ text: value, sources: [] }];

function node(id, kind, title, { children = [], sentences = [], segments = null, failed } = {}) {
  return { id, kind, title, children, sentences, path: [], segments, failed: failed === true };
}

// root > [Alpha > [p1 (1-2), p2 (5)], Beta > [p3 (3-4)]]
function sampleTree() {
  return {
    rootId: 'r',
    nodes: {
      p1: node('p1', 'passage', 'Opening', { sentences: [1, 2], segments: text('One two.') }),
      p2: node('p2', 'passage', 'Closing', { sentences: [5], segments: text('Five.') }),
      p3: node('p3', 'passage', 'Middle', { sentences: [3, 4], segments: text('Three four.') }),
      a: node('a', 'topic', 'Alpha', {
        children: ['p1', 'p2'],
        sentences: [1, 2, 5],
        segments: [
          { text: 'Alpha ', sources: [{ kind: 'claim', child: 'p1', segment: 0 }] },
          { text: 'summary.', sources: [] },
        ],
      }),
      b: node('b', 'topic', 'Beta', {
        children: ['p3'],
        sentences: [3, 4],
        segments: text('Beta summary.'),
      }),
      r: node('r', 'root', 'Article', {
        children: ['a', 'b'],
        sentences: [1, 2, 3, 4, 5],
        segments: text('Overview.'),
      }),
    },
  };
}

describe('projectSummaryTreeTopics', () => {
  it('returns null without a tree or root', () => {
    expect(projectSummaryTreeTopics(null)).toBeNull();
    expect(projectSummaryTreeTopics(undefined)).toBeNull();
    expect(projectSummaryTreeTopics({ rootId: null, nodes: {} })).toBeNull();
    expect(projectSummaryTreeTopics({ rootId: 'x', nodes: {} })).toBeNull();
  });

  it('maps passages to leaf topics with canonical paths and one-based sentences', () => {
    const { topics } = projectSummaryTreeTopics(sampleTree());
    expect(topics).toEqual([
      { name: 'Alpha>Opening', sentences: [1, 2] },
      { name: 'Alpha>Closing', sentences: [5] },
      { name: 'Beta>Middle', sentences: [3, 4] },
    ]);
  });

  it('indexes every topic and passage in the pipeline summary shape, without the root', () => {
    const index = projectSummaryTreeTopics(sampleTree()).topic_summary_index;
    expect(Object.keys(index)).toEqual([
      'Alpha',
      'Alpha>Opening',
      'Alpha>Closing',
      'Beta',
      'Beta>Middle',
    ]);
    expect(index.Beta).toEqual({
      runs: [{ sentences: [3, 4], text: 'Beta summary.' }],
      level: 0,
      source_sentences: [3, 4],
    });
    expect(index['Alpha>Opening'].level).toBe(1);
    // A recurring topic keeps one run per stretch, each carrying its summary.
    expect(index.Alpha.runs).toEqual([
      { sentences: [1, 2], text: 'Alpha summary.' },
      { sentences: [5], text: 'Alpha summary.' },
    ]);
  });

  it('shows a recurring topic summary on every occurrence card', () => {
    const cards = buildSummaryCards(projectSummaryTreeTopics(sampleTree()).topic_summary_index);
    const alpha = cards.filter((card) => card.path === 'Alpha');
    expect(alpha.map((card) => [card.key, card.text, card.sourceSentences])).toEqual([
      ['Alpha#0#0', 'Alpha summary.', [1, 2]],
      ['Alpha#0#1', 'Alpha summary.', [5]],
    ]);
    expect(
      selectCurrentTopicSummary({
        showSummaryMode: false,
        activeTopic: { cardKey: 'Alpha#0#1', path: 'Alpha' },
        allSummaryCards: cards,
      }),
    ).toMatchObject({ key: 'Alpha#0#1', text: 'Alpha summary.' });
  });

  it('returns null when no leaf topic survives', () => {
    const tree = {
      rootId: 'r',
      nodes: {
        p: node('p', 'passage', 'Empty', { sentences: [] }),
        t: node('t', 'topic', 'Topic', { children: ['p'], sentences: [1] }),
        r: node('r', 'root', 'Article', { children: ['t'], sentences: [1] }),
      },
    };
    expect(projectSummaryTreeTopics(tree)).toBeNull();
    expect(projectSummaryTreeTopics({ rootId: 'r', nodes: { r: tree.nodes.r } })).toBeNull();
  });

  it('feeds the aggregated and chronological builders and the summary cards', () => {
    const { topics, topic_summary_index: index } = projectSummaryTreeTopics(sampleTree());
    const roots = buildTopicTree(topics);
    expect(roots.map((entry) => entry.node.fullPath)).toEqual(['Alpha', 'Beta']);
    expect([...roots[0].children.keys()]).toEqual(['Opening', 'Closing']);
    const flat = flattenTopicHierarchy(buildTopicHierarchyTree(topics, 1));
    expect(flat.map((entry) => entry.fullPath)).toEqual([
      'Alpha',
      'Alpha > Opening',
      'Alpha > Closing',
      'Beta',
      'Beta > Middle',
    ]);
    const cards = buildSummaryCards(index);
    expect(cards.find((card) => card.path === 'Beta')).toMatchObject({
      text: 'Beta summary.',
      levelIndex: 0,
      startSentence: 3,
    });
  });

  it('places passages directly under the root at the top level', () => {
    const tree = {
      rootId: 'r',
      nodes: {
        p: node('p', 'passage', 'Only', { sentences: [1], segments: text('Text.') }),
        r: node('r', 'root', 'Article', { children: ['p'], sentences: [1] }),
      },
    };
    const projected = projectSummaryTreeTopics(tree);
    expect(projected.topics).toEqual([{ name: 'Only', sentences: [1] }]);
    expect(projected.topic_summary_index.Only.level).toBe(0);
  });

  it('disambiguates duplicate sibling titles so paths stay unique', () => {
    const tree = {
      rootId: 'r',
      nodes: {
        p1: node('p1', 'passage', 'Same', { sentences: [1] }),
        p2: node('p2', 'passage', 'Same', { sentences: [2] }),
        p3: node('p3', 'passage', 'Same', { sentences: [3] }),
        t: node('t', 'topic', 'Topic', { children: ['p1', 'p2', 'p3'], sentences: [1, 2, 3] }),
        r: node('r', 'root', 'Article', { children: ['t'] }),
      },
    };
    expect(projectSummaryTreeTopics(tree).topics.map((topic) => topic.name)).toEqual([
      'Topic>Same',
      'Topic>Same (2)',
      'Topic>Same (3)',
    ]);
  });

  it('cleans path separators and falls back to sentence ranges for blank titles', () => {
    const tree = {
      rootId: 'r',
      nodes: {
        p1: node('p1', 'passage', 'A > B', { sentences: [1] }),
        p2: node('p2', 'passage', '  ', { sentences: [2, 3] }),
        r: node('r', 'root', 'Article', { children: ['p1', 'p2'] }),
      },
    };
    expect(projectSummaryTreeTopics(tree).topics.map((topic) => topic.name)).toEqual([
      'A B',
      'Sentences 2–3',
    ]);
  });

  it('keeps pending and failed nodes with empty summaries', () => {
    const tree = {
      rootId: 'r',
      nodes: {
        p1: node('p1', 'passage', 'Pending', { sentences: [1] }),
        p2: node('p2', 'passage', 'Failed', { sentences: [2], segments: [], failed: true }),
        r: node('r', 'root', 'Article', { children: ['p1', 'p2'] }),
      },
    };
    const { topics, topic_summary_index: index } = projectSummaryTreeTopics(tree);
    expect(topics).toHaveLength(2);
    expect(index.Pending.runs).toEqual([{ sentences: [1], text: '' }]);
    expect(index.Failed.runs).toEqual([{ sentences: [2], text: '', error: true }]);
  });

  it('assigns each sentence to one leaf and drops invalid sentence numbers', () => {
    const tree = {
      rootId: 'r',
      nodes: {
        p1: node('p1', 'passage', 'First', { sentences: [2, 1, 1, 0, -3, 1.5] }),
        p2: node('p2', 'passage', 'Overlap', { sentences: [2, 3] }),
        p3: node('p3', 'passage', 'Covered', { sentences: [3] }),
        p4: node('p4', 'passage', 'Empty', { sentences: [] }),
        r: node('r', 'root', 'Article', { children: ['p1', 'p2', 'p3', 'p4', 'missing'] }),
      },
    };
    const { topics, topic_summary_index: index } = projectSummaryTreeTopics(tree);
    expect(topics).toEqual([
      { name: 'First', sentences: [1, 2] },
      { name: 'Overlap', sentences: [3] },
    ]);
    expect(index.Empty).toBeUndefined();
    // Only shown leaves are indexed, with the sentences they own.
    expect(index.Covered).toBeUndefined();
    expect(index.Overlap.source_sentences).toEqual([3]);
    expect(index.Overlap.runs).toEqual([{ sentences: [3], text: '' }]);
  });

  it('drops a topic whose leaves are all covered by earlier leaves', () => {
    const tree = {
      rootId: 'r',
      nodes: {
        p1: node('p1', 'passage', 'First', { sentences: [1, 2] }),
        p2: node('p2', 'passage', 'Again', { sentences: [2] }),
        a: node('a', 'topic', 'Kept', { children: ['p1'], sentences: [1, 2] }),
        b: node('b', 'topic', 'Gone', { children: ['p2'], sentences: [2] }),
        r: node('r', 'root', 'Article', { children: ['a', 'b'] }),
      },
    };
    const { topics, topic_summary_index: index } = projectSummaryTreeTopics(tree);
    expect(topics).toEqual([{ name: 'Kept>First', sentences: [1, 2] }]);
    expect(Object.keys(index)).toEqual(['Kept', 'Kept>First']);
  });

  it('survives cyclic or repeated child links', () => {
    const tree = {
      rootId: 'r',
      nodes: {
        p: node('p', 'passage', 'Leaf', { sentences: [1] }),
        t: node('t', 'topic', 'Loop', { children: ['t', 'r', 'p'], sentences: [1] }),
        r: node('r', 'root', 'Article', { children: ['t'] }),
      },
    };
    expect(projectSummaryTreeTopics(tree).topics).toEqual([{ name: 'Loop>Leaf', sentences: [1] }]);
  });
});
