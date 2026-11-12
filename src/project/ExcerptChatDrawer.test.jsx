// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ExcerptChatDrawer } from './ExcerptChatDrawer.jsx';

const chat = vi.hoisted(() => ({ props: null }));
vi.mock('../chat/ArticleChat.jsx', () => ({
  default: (props) => {
    chat.props = props;
    return null;
  },
}));

let root;
afterEach(() => {
  act(() => root?.unmount());
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

it('unfolds the cited passage when a chat event is picked', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  root = createRoot(container);
  const excerpt = {
    id: 'excerpt-1',
    text: 'The first claim opens the excerpt here. The second claim follows it closely. The third claim ends the passage.',
    url: 'https://example.com',
  };
  await act(async () =>
    root.render(<ExcerptChatDrawer excerpt={excerpt} readPage={vi.fn()} onClose={() => {}} />),
  );
  const card = () => container.querySelector('.chat-passage-card');

  // Streamed or repainted ranges are not picks.
  await act(async () => chat.props.onHighlight({ startLine: 1, endLine: 1, label: '' }));
  expect(card()).toBeNull();

  await act(async () =>
    chat.props.onHighlight({ startLine: 2, endLine: 3, label: 'Key claim' }, { focus: true }),
  );
  expect(card().textContent).toContain('Key claim · Lines 2–3');
  expect(card().querySelector('blockquote').textContent).toBe(
    'The second claim follows it closely. The third claim ends the passage.',
  );

  act(() => chat.props.onClearHighlights());
  expect(card()).toBeNull();

  await act(async () => chat.props.onHighlight({ startLine: 9, endLine: 9 }, { focus: true }));
  expect(card().getAttribute('aria-label')).toBe('Chat evidence from this excerpt');
  expect(card().textContent).toContain('no longer in the source text');
  act(() => card().querySelector('.chat-passage-card-close').click());
  expect(card()).toBeNull();
});

it('shares a page read across tools and reloads when the bound reader changes', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  root = createRoot(document.createElement('div'));
  const excerpt = { id: 'excerpt-1', text: 'Excerpt.', url: 'https://example.com' };
  const firstReader = vi.fn(async () => ({ sentences: ['Excerpt.', 'First project text.'] }));
  const secondReader = vi.fn(async () => ({ sentences: ['Excerpt.', 'Second project text.'] }));
  const render = (readPage) =>
    root.render(<ExcerptChatDrawer excerpt={excerpt} readPage={readPage} onClose={() => {}} />);
  await act(async () => render(firstReader));
  const [read, search] = chat.props.tools;
  expect(await read.run({}, { maxChars: 1000 })).toContain('First project text.');
  await search.run({ query: 'project' }, { maxChars: 1000 });
  expect(firstReader).toHaveBeenCalledOnce();
  expect(firstReader).toHaveBeenCalledWith('excerpt-1');

  await act(async () => render(secondReader));
  expect(await chat.props.tools[0].run({}, { maxChars: 1000 })).toContain('Second project text.');
  expect(secondReader).toHaveBeenCalledWith('excerpt-1');
});
