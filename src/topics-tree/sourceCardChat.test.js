import { describe, expect, it } from 'vitest';
import { articlesFromMergedRows, describeSourceCard } from './sourceCardChat.js';

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
