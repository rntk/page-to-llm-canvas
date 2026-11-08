import { describe, expect, it } from 'vitest';
import {
  MAX_EXCERPT_CHARS,
  createExcerpt,
  createExcerptStore,
  normalizeExcerptText,
  normalizeStoredExcerpts,
} from './excerpts.js';

const identity = { id: 'ex-1', now: 5 };

function memoryStore() {
  const data = {};
  const store = createExcerptStore({
    get: async (key) => ({ [key]: data[key] }),
    set: async (items) => Object.assign(data, items),
    queue: (_key, fn) => fn(),
    key: 'excerpts',
  });
  return { store, data };
}

describe('createExcerpt', () => {
  it('normalizes the text and drops the URL fragment', () => {
    expect(
      createExcerpt(
        {
          projectId: 'p1',
          url: 'https://a.test/x#part',
          title: 'A',
          text: '  One.  \r\n\n\n\nTwo. ',
        },
        identity,
      ),
    ).toEqual({
      id: 'ex-1',
      projectId: 'p1',
      url: 'https://a.test/x',
      title: 'A',
      text: 'One.\n\nTwo.',
      truncated: false,
      createdAt: 5,
    });
  });

  it('cuts an oversized selection and marks it', () => {
    const excerpt = createExcerpt(
      { projectId: 'p1', url: 'https://a.test', text: 'x'.repeat(MAX_EXCERPT_CHARS + 10) },
      identity,
    );
    expect(excerpt.text).toHaveLength(MAX_EXCERPT_CHARS);
    expect(excerpt.truncated).toBe(true);
  });

  it('refuses blank text, unusable URLs and colon ids', () => {
    expect(createExcerpt({ projectId: 'p1', url: 'https://a.test', text: ' \n ' }, identity)).toBe(
      null,
    );
    expect(createExcerpt({ projectId: 'p1', url: 'not a url', text: 'x' }, identity)).toBe(null);
    expect(
      createExcerpt({ projectId: 'p1', url: 'https://a.test', text: 'x' }, { id: 'a:b', now: 1 }),
    ).toBe(null);
  });
});

describe('normalizeExcerptText', () => {
  it('returns an empty string for non-strings', () => {
    expect(normalizeExcerptText(undefined)).toBe('');
  });
});

describe('normalizeStoredExcerpts', () => {
  it('drops invalid and duplicate entries and a focus on a missing excerpt', () => {
    const good = { id: 'a', projectId: 'p', url: 'https://a.test', text: 't' };
    expect(
      normalizeStoredExcerpts({
        excerpts: [good, { ...good, text: 'dup' }, { id: 'b' }, null],
        focus: { projectId: 'p', excerptId: 'gone' },
      }),
    ).toEqual({
      excerpts: [{ ...good, url: 'https://a.test/', title: '', truncated: false, createdAt: 0 }],
      focus: null,
    });
    expect(normalizeStoredExcerpts(undefined)).toEqual({ excerpts: [], focus: null });
  });
});

describe('createExcerptStore', () => {
  const excerpt = (id, projectId = 'p1') =>
    createExcerpt({ projectId, url: 'https://a.test', text: `text ${id}` }, { id, now: 1 });

  it('lists a project’s excerpts and keeps its focus request until acknowledged', async () => {
    const { store } = memoryStore();
    await store.add(excerpt('a'));
    await store.add(excerpt('b', 'p2'));
    await store.add(excerpt('c'), { focus: true });

    expect((await store.listForProject('p1')).map((e) => e.id)).toEqual(['a', 'c']);
    expect(await store.peekFocus('p2')).toBe(null);
    expect(await store.peekFocus('p1')).toBe('c');
    expect(await store.peekFocus('p1')).toBe('c');
    await store.acknowledgeFocus('p1', 'a');
    expect(await store.peekFocus('p1')).toBe('c');
    await store.acknowledgeFocus('p1', 'c');
    await store.acknowledgeFocus('p1', 'c');
    expect(await store.peekFocus('p1')).toBe(null);
  });

  it('removes matching excerpts and clears a focus that pointed at them', async () => {
    const { store } = memoryStore();
    await store.add(excerpt('a'), { focus: true });
    await store.add(excerpt('b'));
    const removed = await store.removeWhere((e) => e.id === 'a');
    expect(removed.map((e) => e.id)).toEqual(['a']);
    expect((await store.read()).focus).toBe(null);
    expect(await store.removeWhere(() => false)).toEqual([]);
  });
});
