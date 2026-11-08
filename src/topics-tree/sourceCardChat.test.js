import { describe, expect, it } from 'vitest';
import { articlesFromMergedRows, describeSourceCard } from './sourceCardChat.js';
import { passageKey } from './topicsTreeModel.js';
import { buildProjectTopicSeed } from '../core/projects/projectTopicTree.js';

// Two articles merged into rows 1-5: A has 3 sentences, B has 2.
const rows = ['A one.', 'A two.', 'A three.', 'B one.', 'B two.'];
const sources = {
  1: { recordKey: 'a', sentenceId: 1, title: 'Article A', url: 'https://a.test/' },
  2: { recordKey: 'a', sentenceId: 2, title: 'Article A', url: 'https://a.test/' },
  3: { recordKey: 'a', sentenceId: 3, title: 'Article A', url: 'https://a.test/' },
  4: { recordKey: 'b', sentenceId: 1, title: 'Article B', url: 'https://b.test/' },
  5: { recordKey: 'b', sentenceId: 2, title: 'Article B', url: 'https://b.test/' },
};
const records = [
  { key: 'a', title: 'Article A', url: 'https://a.test/', contentRevision: 'rev-a' },
  { key: 'b', title: 'Article B', url: 'https://b.test/', contentRevision: 'rev-b' },
];

describe('articlesFromMergedRows', () => {
  it('rebuilds each article in its own sentence order', () => {
    const articles = articlesFromMergedRows(rows, sources);
    expect(articles.get('a')).toEqual(['A one.', 'A two.', 'A three.']);
    expect(articles.get('b')).toEqual(['B one.', 'B two.']);
  });

  it('skips rows without a usable source and fills gaps', () => {
    const articles = articlesFromMergedRows(rows, {
      2: { recordKey: 'a', sentenceId: 2 },
      3: { recordKey: 'a' },
      4: null,
    });
    expect(articles.get('a')).toEqual(['', 'A two.']);
    expect(articles.size).toBe(1);
  });

  it('uses only the latest appended version when an article shrinks or grows', () => {
    const record = (key, sentences) => ({ key, sentences, topics: [] });
    const original = buildProjectTopicSeed([
      record('a', ['Old one.', 'Obsolete two.', 'Obsolete three.']),
      record('b', ['Unchanged.']),
    ]);
    const shortened = buildProjectTopicSeed([record('a', ['New one.'])], { base: original });
    const articles = articlesFromMergedRows(shortened.sentences, shortened.sources);
    expect(articles.get('a')).toEqual(['New one.']);
    expect(articles.get('b')).toEqual(['Unchanged.']);

    const extended = buildProjectTopicSeed([record('a', ['Latest one.', 'Latest two.'])], {
      base: shortened,
    });
    expect(articlesFromMergedRows(extended.sentences, extended.sources).get('a')).toEqual([
      'Latest one.',
      'Latest two.',
    ]);
  });
});

describe('describeSourceCard', () => {
  const article = { key: 'rec', title: 'Title', url: 'https://x.test/', contentRevision: 'r1' };
  const single = ['One.', 'Two.', 'Three.', 'Four.'];

  it('describes a card of a single article by its own sentence numbers', () => {
    expect(describeSourceCard({ node: { sentences: [2, 3] }, sentences: single, article })).toEqual(
      {
        chatKey: 'card:2-3:rec',
        title: 'Title',
        url: 'https://x.test/',
        contentRevision: 'r1',
        cardSentences: ['Two.', 'Three.'],
        lineKeys: [passageKey('', 2), passageKey('', 3)],
        pageSentences: single,
      },
    );
  });

  it('describes a merged-tree card by the article it quotes and its local lines', () => {
    const getArticles = () => articlesFromMergedRows(rows, sources);
    const card = describeSourceCard({
      node: { sentences: [4, 5] },
      sentences: rows,
      sentenceSources: sources,
      records,
      getArticles,
    });
    expect(card).toMatchObject({
      chatKey: 'card:1-2:b',
      title: 'Article B',
      url: 'https://b.test/',
      contentRevision: 'rev-b',
      cardSentences: ['B one.', 'B two.'],
      pageSentences: ['B one.', 'B two.'],
    });
  });

  it('has no chat for a card spanning articles, a source-less row or a missing article', () => {
    const getArticles = () => articlesFromMergedRows(rows, sources);
    const base = { sentences: rows, sentenceSources: sources, records, getArticles };
    expect(describeSourceCard({ ...base, node: { sentences: [3, 4] } })).toBeNull();
    expect(describeSourceCard({ ...base, node: { sentences: [9] } })).toBeNull();
    expect(describeSourceCard({ ...base, node: { sentences: [] } })).toBeNull();
    expect(
      describeSourceCard({ ...base, getArticles: () => new Map(), node: { sentences: [1] } }),
    ).toBeNull();
    expect(
      describeSourceCard({ node: { sentences: [1] }, sentences: single, article: null }),
    ).toBeNull();
  });
});

describe('describeSourceCard for a topic source block', () => {
  const sections = [
    { key: 'source:x', path: 'Fruit>Apples', sentences: [1, 2] },
    { key: 'source:y', path: 'Fruit>Pears', sentences: [2, 4] },
  ];

  it('describes a block of one article with a heading per section', () => {
    const article = { key: 'rec', title: 'Title', url: 'https://x.test/', contentRevision: 'r1' };
    const single = ['One.', 'Two.', 'Three.', 'Four.'];
    const card = describeSourceCard({
      node: { sections, sentences: [1, 2, 4], path: 'Fruit' },
      sentences: single,
      article,
    });
    expect(card.chatKey).toMatch(/^block:[0-9a-z]+:rec$/);
    expect(card).toMatchObject({ topic: 'Fruit', contentRevision: 'r1' });
    expect(card.cardSentences).toEqual([
      '### Section 1 - topic: Fruit > Apples - page 1 - page lines 1-2',
      'One.',
      'Two.',
      '### Section 2 - topic: Fruit > Pears - page 1 - page lines 2, 4',
      'Two.',
      'Four.',
    ]);
    // Headings show no passage; the same sentence stays distinct per section.
    expect(card.lineKeys).toEqual([
      null,
      passageKey('source:x', 1),
      passageKey('source:x', 2),
      null,
      passageKey('source:y', 2),
      passageKey('source:y', 4),
    ]);
    expect(card.pages).toEqual([
      {
        title: 'Title',
        url: 'https://x.test/',
        excerptSentences: ['One.', 'Two.', 'Two.', 'Four.'],
        pageSentences: single,
      },
    ]);
  });

  it('numbers the pages of a merged tree and keeps the chat under the project', () => {
    const getArticles = () => articlesFromMergedRows(rows, sources);
    const mixed = [
      { key: 's1', path: 'T>A', sentences: [1, 4] },
      { key: 's2', path: 'T>B', sentences: [5] },
    ];
    const card = describeSourceCard({
      node: { sections: mixed, sentences: [1, 4, 5], path: 'T' },
      sentences: rows,
      sentenceSources: sources,
      records,
      getArticles,
      projectId: 'p1',
    });
    expect(card.chatKey).toMatch(/^project:p1:block:/);
    expect(card.contentRevision).toBeUndefined();
    expect(card.pages.map((page) => page.title)).toEqual(['Article A', 'Article B']);
    expect(card.pages[1].pageSentences).toEqual(['B one.', 'B two.']);
    expect(card.cardSentences).toEqual([
      '### Section 1 - topic: T > A - page 1 - page lines 1',
      'A one.',
      '### Section 1 - topic: T > A - page 2 - page lines 1',
      'B one.',
      '### Section 2 - topic: T > B - page 2 - page lines 2',
      'B two.',
    ]);
  });

  it('has no chat when a mixed block has no project to own it, or a page is unreadable', () => {
    const getArticles = () => articlesFromMergedRows(rows, sources);
    const mixed = [{ key: 's1', path: 'T', sentences: [1, 4] }];
    const base = { sentences: rows, sentenceSources: sources, records, getArticles };
    const node = { sections: mixed, sentences: [1, 4], path: 'T' };
    expect(describeSourceCard({ ...base, node })).toBeNull();
    expect(
      describeSourceCard({ ...base, node, projectId: 'p1', getArticles: () => new Map() }),
    ).toBeNull();
  });
});
