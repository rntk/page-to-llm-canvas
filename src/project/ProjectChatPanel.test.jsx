// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./ProjectChat.jsx', () => ({
  ProjectChat: (props) => (
    <div data-testid="project-chat" data-stale={String(props.stale)}>
      chat {props.projectId} {props.tree.rootId} {props.eligiblePages.length}
    </div>
  ),
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

const doneData = (overrides = {}) => ({
  status: 'done',
  tree: { rootId: 'root' },
  stale: false,
  eligiblePages: [{ key: 'a' }, { key: 'b' }],
  skippedPages: [],
  ...overrides,
});

async function render(props) {
  await act(async () =>
    root.render(<ProjectChatPanel projectId="p" onCollapse={() => {}} {...props} />),
  );
}
const buttons = () => [...container.querySelectorAll('button')].map((b) => b.textContent);

describe('ProjectChatPanel', () => {
  it('shows a loading state, then the chat for a complete merge', async () => {
    let resolve;
    const api = { getProjectChatTree: vi.fn(() => new Promise((r) => (resolve = r))) };
    await render({ api });
    expect(container.textContent).toContain('Loading project chat');
    await act(async () => resolve(doneData()));
    expect(api.getProjectChatTree).toHaveBeenCalledWith('p');
    expect(container.querySelector('[data-testid="project-chat"]').textContent).toBe(
      'chat p root 2',
    );
    expect(container.querySelector('.chat-panel-notice')).toBeNull();
    expect(container.textContent).not.toContain('not included');
  });

  it('shows the stale notice with a rebuild button and the skipped-page note', async () => {
    const onOpenMerge = vi.fn();
    const api = {
      getProjectChatTree: vi.fn(async () =>
        doneData({ stale: true, skippedPages: [{ key: 'x' }, { key: 'y' }] }),
      ),
    };
    await render({ api, onOpenMerge });
    expect(container.querySelector('.chat-panel-notice').textContent).toContain(
      'Pages or topics changed since this merge. Answers use the saved merge — rebuild to include current pages.',
    );
    expect(container.querySelector('[data-testid="project-chat"]').dataset.stale).toBe('true');
    expect(container.textContent).toContain('2 pages are not included');
    await act(async () =>
      [...container.querySelectorAll('button')]
        .find((b) => b.textContent === 'Rebuild merge')
        .click(),
    );
    expect(onOpenMerge).toHaveBeenCalledTimes(1);
  });

  it('uses the singular note for one skipped page', async () => {
    const api = { getProjectChatTree: vi.fn(async () => doneData({ skippedPages: [{}] })) };
    await render({ api });
    expect(container.textContent).toContain('1 page is not included');
  });

  it('explains a missing merge and opens the merge view', async () => {
    const onOpenMerge = vi.fn();
    const api = {
      getProjectChatTree: vi.fn(async () => ({
        status: 'missing',
        tree: null,
        stale: false,
        eligiblePages: [],
        skippedPages: [],
      })),
    };
    await render({ api, onOpenMerge });
    expect(container.querySelector('[data-testid="project-chat"]')).toBeNull();
    expect(container.textContent).toContain('Merge similar topics first');
    await act(async () =>
      [...container.querySelectorAll('button')]
        .find((b) => b.textContent === 'Merge similar topics')
        .click(),
    );
    expect(onOpenMerge).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['running', 'still being merged'],
    ['interrupted', 'stopped before it finished'],
    ['cancelled', 'was stopped'],
    ['error', 'failed'],
  ])('explains an incomplete %s merge', async (status, text) => {
    const api = {
      getProjectChatTree: vi.fn(async () => ({ status, tree: null, eligiblePages: [] })),
    };
    await render({ api, onOpenMerge: () => {} });
    expect(container.querySelector('.chat-panel-body').textContent).toContain(text);
    expect(buttons()).toContain('Open topic merge');
    expect(container.querySelector('[data-testid="project-chat"]')).toBeNull();
  });

  it('omits the merge button without a handler', async () => {
    const api = { getProjectChatTree: vi.fn(async () => ({ status: 'missing', tree: null })) };
    await render({ api });
    expect(buttons()).toEqual(['Hide']);
  });

  it('refetches when the merge key changes and keeps the chat mounted meanwhile', async () => {
    let data = { status: 'running', tree: null };
    const api = { getProjectChatTree: vi.fn(async () => data) };
    await render({ api, mergeKey: 'running' });
    expect(container.textContent).toContain('still being merged');
    data = doneData();
    await render({ api, mergeKey: 'done' });
    expect(api.getProjectChatTree).toHaveBeenCalledTimes(2);
    const chat = container.querySelector('[data-testid="project-chat"]');
    expect(chat).not.toBeNull();
    let resolve;
    api.getProjectChatTree.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    await render({ api, mergeKey: 'done-2' });
    expect(container.querySelector('[data-testid="project-chat"]')).toBe(chat);
    await act(async () => resolve(doneData({ stale: true })));
    expect(container.querySelector('.chat-panel-notice')).not.toBeNull();
  });

  it('shows an error, and keeps the last tree if a refresh fails', async () => {
    const api = { getProjectChatTree: vi.fn(async () => Promise.reject(new Error('boom'))) };
    await render({ api });
    expect(container.querySelector('[role="alert"]').textContent).toBe('boom');

    const api2 = { getProjectChatTree: vi.fn(async () => doneData()) };
    await render({ api: api2, mergeKey: '1' });
    api2.getProjectChatTree.mockRejectedValueOnce(new Error('later'));
    await render({ api: api2, mergeKey: '2' });
    expect(container.querySelector('[data-testid="project-chat"]')).not.toBeNull();
  });

  it('reports an unavailable api and collapses', async () => {
    const onCollapse = vi.fn();
    await render({ api: {}, onCollapse });
    expect(container.querySelector('[role="alert"]').textContent).toBe(
      'Project chat is not available',
    );
    await act(async () => container.querySelector('[aria-label="Collapse project chat"]').click());
    expect(onCollapse).toHaveBeenCalled();
  });
});
