import { describe, expect, it } from 'vitest';
import { createTreeModel } from './projectTreeModel.js';
import { createTopicSearch } from './projectTopicSearch.js';

function makeSearch() {
  const tree = {
    rootId: 'root',
    records: [
      { key: 'a', title: 'A' },
      { key: 'b', title: 'B' },
    ],
    sentences: [
      'Solar panels reduce household energy costs.',
      'Ocean tides power coastal turbines.',
    ],
    sources: {
      1: { recordKey: 'a', sentenceId: 1 },
      2: { recordKey: 'b', sentenceId: 1 },
    },
    nodes: {
      root: {
        id: 'root',
        kind: 'root',
        title: 'Project',
        children: ['solar', 'tide'],
        sentences: [1, 2],
      },
      solar: {
        id: 'solar',
        kind: 'topic',
        title: 'Solar energy',
        children: ['solar-passage'],
        sentences: [1],
        segments: [
          {
            text: 'Photovoltaic technology helps homes.',
            sources: [{ kind: 'rows', first: 1, last: 1 }],
          },
        ],
      },
      'solar-passage': {
        id: 'solar-passage',
        kind: 'passage',
        title: 'Solar evidence',
        sentences: [1],
      },
      tide: {
        id: 'tide',
        kind: 'topic',
        title: 'Coastal power',
        children: ['tide-passage'],
        sentences: [2],
      },
      'tide-passage': {
        id: 'tide-passage',
        kind: 'passage',
        title: 'Tidal evidence',
        sentences: [2],
      },
      hidden: { id: 'hidden', kind: 'topic', title: 'Solar hidden', children: [], sentences: [1] },
    },
  };
  return createTopicSearch(createTreeModel(tree));
}

describe('createTopicSearch', () => {
  it('ranks title, summary, and sentence matches, returning evidence hits', () => {
    const results = makeSearch()('solar photovoltaic');
    expect(results[0].node.id).toBe('solar');
    expect(results[0].inSummary).toBe(true);
    expect(results.find((result) => result.node.id === 'solar-passage').hits).toEqual([
      expect.objectContaining({ id: 1 }),
    ]);
    expect(results[0].articles.map((article) => article.key)).toEqual(['a']);
    expect(results.some((result) => result.node.id === 'hidden')).toBe(false);
  });

  it('falls back to stopwords for a stopword-only query and rejects an empty query', () => {
    const search = makeSearch();
    expect(search('the')).toHaveLength(0);
    expect(() => search('   ')).toThrow('query must contain at least one word to search for');
  });
});
