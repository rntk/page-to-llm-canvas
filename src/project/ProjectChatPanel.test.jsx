// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const chatProps = vi.hoisted(() => ({ last: null }));
vi.mock('./ProjectChat.jsx', () => ({
  ProjectChat: (props) => {
    chatProps.last = props;
    return (
      <div data-testid="project-chat" data-stale={String(props.stale)}>
        chat {props.projectId} {props.tree ? props.tree.rootId : 'no tree'}{' '}
        {props.pages.map((page) => `${page.page}:${page.title}`).join(',')}
      </div>
    );
  },
}));

const { ProjectChatPanel } = await import('./ProjectChatPanel.jsx');

let container;
let root;

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

const doneMerge = (overrides = {}) => ({
  status: 'done',
  tree: { rootId: 'root' },
  stale: false,
  eligiblePages: [
    { key: 'a', title: 'Saved A', url: 'https://a.test/' },
    { key: 'b', title: 'Saved B', url: 'https://b.test/' },
  ],
  skippedPages: [],
  ...overrides,
});
const tabsOf = () => [
  { id: 1, title: 'Tab B', url: 'https://b.test/#top' },
  { id: 2, title: 'Settings', url: 'chrome://settings' },
];

const readPage = vi.fn();
const send = vi.fn();

async function render(props) {
  await act(async () =>
    root.render(
      <ProjectChatPanel
        projectId="p"
        readPage={readPage}
        send={send}
        onCollapse={() => {}}
        {...props}
      />,
    ),
  );
}
const buttons = () => [...container.querySelectorAll('button')].map((b) => b.textContent);
const chat = () => container.querySelector('[data-testid="project-chat"]');

describe('ProjectChatPanel', () => {
  it('shows the chat with the tree for a complete merge, merging tabs and saved pages', async () => {
    await render({ merge: doneMerge(), tabs: tabsOf() });
    expect(chat().textContent).toBe('chat p root 1:Saved A,2:Tab B');
    expect(chatProps.last.tree).toEqual({ rootId: 'root' });
    expect(chatProps.last.readPage).toBe(readPage);
    expect(chatProps.last.send).toBe(send);
    expect(chatProps.last.unreadablePages).toEqual([
      expect.objectContaining({ title: 'Settings', url: 'chrome://settings' }),
    ]);
    expect(container.querySelector('.chat-panel-notice')).toBeNull();
    expect(container.textContent).not.toContain('not in the topic tree');
  });

  it('shows the stale notice with a rebuild button and the skipped-page note', async () => {
    const onOpenMerge = vi.fn();
    await render({
      merge: doneMerge({ stale: true, skippedPages: [{ key: 'x' }, { key: 'y' }] }),
      onOpenMerge,
    });
    expect(container.querySelector('.chat-panel-notice').textContent).toContain(
      'Pages or topics changed since this merge. Answers use the saved merge — rebuild to include current pages.',
    );
    expect(chat().dataset.stale).toBe('true');
    expect(container.textContent).toContain('2 pages are not in the topic tree');
    await act(async () =>
      [...container.querySelectorAll('button')]
        .find((b) => b.textContent === 'Rebuild merge')
        .click(),
    );
    expect(onOpenMerge).toHaveBeenCalledTimes(1);
  });

  it('uses the singular note for one skipped page', async () => {
    await render({ merge: doneMerge({ skippedPages: [{}] }) });
    expect(container.textContent).toContain('1 page is not in the topic tree');
  });

  it('chats over the open tabs without a merge and offers the merge as optional', async () => {
    const onOpenMerge = vi.fn();
    await render({
      merge: { status: 'missing', tree: null, stale: false, eligiblePages: [], skippedPages: [] },
      tabs: tabsOf(),
      onOpenMerge,
    });
    expect(chat().textContent).toBe('chat p no tree 1:Tab B');
    expect(chatProps.last.tree).toBeNull();
    expect(container.textContent).toContain(
      'Merging similar topics adds a shared topic tree the chat can use.',
    );
    expect(container.textContent).not.toContain('Merge similar topics first');
    await act(async () =>
      [...container.querySelectorAll('button')]
        .find((b) => b.textContent === 'Merge similar topics')
        .click(),
    );
    expect(onOpenMerge).toHaveBeenCalledTimes(1);
  });

  it('treats an absent merge as missing', async () => {
    await render({ merge: undefined, tabs: tabsOf() });
    expect(chat()).not.toBeNull();
    expect(container.textContent).toContain('Merging similar topics adds a shared topic tree');
  });

  it('chats over saved pages when the group is closed and has no tabs', async () => {
    await render({ merge: doneMerge(), tabs: [] });
    expect(chat().textContent).toBe('chat p root 1:Saved A,2:Saved B');
  });

  it.each([[[]], [tabsOf()]])('includes saved merge records with live tabs %j', async (tabs) => {
    const saved = doneMerge().eligiblePages;
    await render({
      merge: doneMerge({ eligiblePages: [], tree: { rootId: 'root', records: saved } }),
      tabs,
    });
    expect(chatProps.last.pages.map((page) => page.url)).toEqual([
      'https://a.test/',
      'https://b.test/',
    ]);
    expect(chatProps.last.pages[0].title).toBe('Saved A');
  });

  it('shows a note instead of the chat when there are no pages', async () => {
    await render({ merge: { status: 'missing', tree: null }, tabs: [] });
    expect(chat()).toBeNull();
    expect(container.textContent).toContain('This project has no pages to chat about yet.');
    expect(container.textContent).not.toContain('Merging similar topics');
  });

  it('says so when no page can be read', async () => {
    await render({
      merge: undefined,
      tabs: [{ id: 2, title: 'Settings', url: 'chrome://settings' }],
    });
    expect(chat()).toBeNull();
    expect(container.textContent).toContain('None of this project’s pages can be read');
  });

  it.each([
    ['running', 'still being merged'],
    ['interrupted', 'stopped before it finished'],
    ['cancelled', 'was stopped'],
    ['error', 'failed'],
  ])('explains an incomplete %s merge without blocking the chat', async (status, text) => {
    await render({
      merge: { status, tree: null, eligiblePages: [] },
      tabs: tabsOf(),
      onOpenMerge: () => {},
    });
    expect(container.querySelector('.chat-panel-body').textContent).toContain(text);
    expect(container.textContent).not.toContain('Chat is available once');
    expect(container.textContent).not.toContain('to chat over this project');
    expect(buttons()).toContain('Open topic merge');
    expect(chat()).not.toBeNull();
    expect(chatProps.last.tree).toBeNull();
  });

  it('omits the merge button without a handler', async () => {
    await render({ merge: { status: 'missing', tree: null }, tabs: tabsOf() });
    expect(buttons()).toEqual(['Hide']);
  });

  it('keeps the same pages array while tab content is unchanged', async () => {
    await render({ merge: undefined, tabs: tabsOf() });
    const { pages, unreadablePages } = chatProps.last;
    await render({ merge: undefined, tabs: tabsOf() });
    expect(chatProps.last.pages).toBe(pages);
    expect(chatProps.last.unreadablePages).toBe(unreadablePages);
    await render({
      merge: undefined,
      tabs: [...tabsOf(), { id: 3, title: 'C', url: 'https://c.test/' }],
    });
    expect(chatProps.last.pages).not.toBe(pages);
  });

  it('follows the merge prop as it changes and collapses', async () => {
    const onCollapse = vi.fn();
    const tabs = tabsOf();
    await render({ merge: { status: 'running', tree: null }, tabs, onCollapse });
    expect(container.textContent).toContain('still being merged');
    const before = chat();
    expect(chatProps.last.tree).toBeNull();
    await render({ merge: doneMerge(), tabs, onCollapse });
    // The chat stays mounted; it just gains the tree.
    expect(chat()).toBe(before);
    expect(chatProps.last.tree).toEqual({ rootId: 'root' });
    await render({ merge: doneMerge({ stale: true }), tabs, onCollapse });
    expect(chat()).toBe(before);
    expect(container.querySelector('.chat-panel-notice')).not.toBeNull();
    await act(async () => container.querySelector('[aria-label="Collapse project chat"]').click());
    expect(onCollapse).toHaveBeenCalled();
  });
});
