// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectTopicTree } from './ProjectTopicTree.jsx';

let container;
let root;
const articleA = { key: 'a', title: 'First article', url: 'https://same.test/a' };
const articleB = { key: 'b', title: 'Second article', url: 'https://same.test/b' };
const tree = {
  runId: 'merge-run',
  status: 'done',
  rootId: 'root',
  records: [articleA, articleB],
  sentences: ['First article line two.', 'First article line five.', 'Second article line two.'],
  sources: {
    1: { ...articleA, recordKey: 'a', sentenceId: 2 },
    2: { ...articleA, recordKey: 'a', sentenceId: 5 },
    3: { ...articleB, recordKey: 'b', sentenceId: 2 },
  },
  nodes: {
    root: {
      id: 'root',
      kind: 'root',
      title: 'Root',
      children: ['merged'],
      sentences: [1, 2, 3],
      segments: [],
    },
    merged: {
      id: 'merged',
      kind: 'topic',
      title: 'Shared subject',
      children: ['a', 'b'],
      sentences: [1, 2, 3],
      segments: [{ text: 'Two perspectives.' }],
    },
    a: {
      id: 'a',
      kind: 'passage',
      title: 'First perspective',
      children: [],
      sentences: [1, 2],
      segments: [{ text: 'First hint.' }],
    },
    b: {
      id: 'b',
      kind: 'passage',
      title: 'Second perspective',
      children: [],
      sentences: [3],
      segments: [{ text: 'Second hint.' }],
    },
  },
};

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

function render(props = {}) {
  const callbacks = { onBuild: vi.fn(), onStop: vi.fn(), onClose: vi.fn() };
  act(() =>
    root.render(
      <ProjectTopicTree
        project={{ title: 'Research' }}
        merge={{
          status: 'done',
          tree,
          eligiblePages: [articleA, articleB],
          skippedPages: [],
          topicCount: 2,
        }}
        {...callbacks}
        {...props}
      />,
    ),
  );
  return callbacks;
}
const button = (label) =>
  [...container.querySelectorAll('button')].find((el) => el.textContent === label);

describe('ProjectTopicTree', () => {
  it('unfolds original text with distinct article titles, URLs and local sentence numbers', () => {
    render();
    expect(container.querySelector('.tt-node--root').textContent).toContain('2 articles');
    act(() => container.querySelector('.tt-node--root .tt-node__count').click());
    const cards = [...container.querySelectorAll('.tt-card')];
    expect(cards).toHaveLength(2);
    expect(cards[0].querySelector('.tt-source-article a').textContent).toBe('First article');
    expect(cards[0].querySelector('.tt-source-article__url').textContent).toBe(articleA.url);
    expect([...cards[0].querySelectorAll('li')].map((el) => el.value)).toEqual([2, 5]);
    expect(cards[0].textContent).toContain('First article line five.');
    expect(cards[1].querySelector('.tt-source-article a').textContent).toBe('Second article');
    expect(cards[1].querySelector('li').value).toBe(2);
    expect(cards[1].textContent).toContain('Second article line two.');
    expect(button('Show in page')).toBeUndefined();
  });

  it('explains skipped pages and source changes, and rebuilds from current inputs', () => {
    const { onBuild, onClose } = render({
      merge: {
        status: 'done',
        tree,
        eligiblePages: [articleA],
        topicCount: 1,
        stale: true,
        skippedPages: [
          { title: 'Unprocessed', url: 'https://other.test/', reason: 'Page is still processing.' },
        ],
      },
    });
    expect(container.textContent).toContain('1 eligible page · 1 primary topic · 1 skipped');
    expect(container.textContent).toContain('Page is still processing.');
    expect(container.textContent).toContain('Rebuild to include the current sources.');
    act(() => button('Rebuild').click());
    expect(onBuild).toHaveBeenCalledWith({ fresh: true });
    act(() => button('Back to canvas').click());
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('offers stop while running and resume after interruption', () => {
    const { onStop } = render({
      merge: {
        status: 'running',
        tree: { ...tree, stage: 'topics', progress: { done: 1, total: 2 } },
      },
    });
    expect(container.textContent).toContain('Merging similar topics 1/2…');
    expect(container.querySelector('.tt-canvas')).toBeNull();
    act(() => button('Stop').click());
    expect(onStop).toHaveBeenCalledOnce();
    const { onBuild } = render({
      merge: { status: 'interrupted', tree, eligiblePages: [articleA] },
    });
    act(() => button('Resume').click());
    expect(onBuild).toHaveBeenCalledWith({ fresh: false });
  });

  it('explains missing inputs without enabling a merge', () => {
    render({ merge: { status: 'missing', eligiblePages: [], skippedPages: [] } });
    expect(container.textContent).toContain('No completed saved pages with primary topics');
    expect(button('Merge similar topics').disabled).toBe(true);
  });
});
