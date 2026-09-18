import { describe, expect, it } from 'vitest';
import { projectArticleView } from './articleView.js';

describe('projectArticleView', () => {
  it.each([
    undefined,
    null,
    {},
    { sentences: null, topics: null },
    { sentences: {}, topics: 'bad' },
  ])('provides empty display collections for incomplete records: %j', (record) => {
    expect(projectArticleView(record)).toEqual({ sentences: [], topics: [] });
  });

  it('preserves source positions and collection identity', () => {
    const record = {
      sentences: ['First.', '', 'Third.'],
      topics: [{ name: 'Topic', sentences: [1, 3] }],
    };
    const view = projectArticleView(record);
    expect(view.sentences).toBe(record.sentences);
    expect(view.topics).toBe(record.topics);
  });

  it('leaves missing, unprocessed, and processed-empty source records distinguishable', () => {
    const records = [
      Object.freeze({ status: 'done' }),
      Object.freeze({ status: 'queued', sentences: null, topics: null }),
      Object.freeze({ status: 'done', sentences: [], topics: [] }),
    ];
    const before = JSON.stringify(records);
    for (const record of records) {
      expect(projectArticleView(record)).toEqual({ sentences: [], topics: [] });
    }
    expect(JSON.stringify(records)).toBe(before);
    expect(Object.hasOwn(records[0], 'sentences')).toBe(false);
    expect(records[1].sentences).toBeNull();
    expect(records[2].sentences).toEqual([]);
  });

  it('reuses immutable defaults across missing records', () => {
    const first = projectArticleView();
    const next = projectArticleView({});
    expect(next.sentences).toBe(first.sentences);
    expect(next.topics).toBe(first.topics);
    expect(Object.isFrozen(first.sentences)).toBe(true);
    expect(Object.isFrozen(first.topics)).toBe(true);
  });
});
