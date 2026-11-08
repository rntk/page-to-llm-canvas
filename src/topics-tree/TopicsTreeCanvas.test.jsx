// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import TopicsTreeCanvas from './TopicsTreeCanvas.jsx';
import { buildSummaryTreeDisplayTree } from './topicsTreeModel.js';

it('reveals a repeated summary locally and remembers it across branch folding', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  const node = (id, children) => ({
    id,
    title: id,
    kind: 'topic',
    children,
    sentences: [1],
    segments: [{ text: 'Shared summary.' }],
  });
  const tree = buildSummaryTreeDisplayTree({
    rootId: 'parent',
    nodes: {
      parent: node('parent', ['child']),
      child: node('child', ['last']),
      last: node('last', []),
    },
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    act(() => root.render(createElement(TopicsTreeCanvas, { tree, sentences: ['Source.'] })));
    const parent = () => container.querySelector('.tt-node--root');
    const child = () =>
      [...container.querySelectorAll('.tt-node')].find(
        (el) => el.querySelector('.tt-node__title').textContent === 'child',
      );
    const button = () => child().querySelector('.tt-node__summary-toggle button');
    const prose = () => child().querySelector('.tt-node__prose');
    expect(parent().querySelector('.tt-node__prose').hidden).toBe(false);
    expect(prose().hidden).toBe(true);
    expect(button().getAttribute('aria-expanded')).toBe('false');
    act(() => button().click());
    expect(prose().hidden).toBe(false);
    expect(button().textContent).toBe('Hide summary');
    expect(button().getAttribute('aria-controls')).toBe(prose().id);
    expect(child().getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelectorAll('.tt-node')).toHaveLength(2);
    act(() => parent().click());
    act(() => parent().click());
    expect(prose().hidden).toBe(false);
    act(() => button().click());
    expect(prose().hidden).toBe(true);
    act(() => child().click());
    expect(container.querySelectorAll('.tt-node')).toHaveLength(3);
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
