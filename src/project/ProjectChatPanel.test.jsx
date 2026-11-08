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

const doneMerge = (overrides = {}) => ({
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
  it('shows the chat for a complete merge', async () => {
    await render({ merge: doneMerge() });
    expect(container.querySelector('[data-testid="project-chat"]').textContent).toBe(
      'chat p root 2',
    );
    expect(container.querySelector('.chat-panel-notice')).toBeNull();
    expect(container.textContent).not.toContain('not included');
    expect(container.textContent).not.toContain('Loading');
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
    await render({ merge: doneMerge({ skippedPages: [{}] }) });
    expect(container.textContent).toContain('1 page is not included');
  });

  it('explains a missing merge and opens the merge view', async () => {
    const onOpenMerge = vi.fn();
    await render({
      merge: { status: 'missing', tree: null, stale: false, eligiblePages: [], skippedPages: [] },
      onOpenMerge,
    });
    expect(container.querySelector('[data-testid="project-chat"]')).toBeNull();
    expect(container.textContent).toContain('Merge similar topics first');
    await act(async () =>
      [...container.querySelectorAll('button')]
        .find((b) => b.textContent === 'Merge similar topics')
        .click(),
    );
    expect(onOpenMerge).toHaveBeenCalledTimes(1);
  });

  it('treats an absent merge as missing', async () => {
    await render({ merge: undefined });
    expect(container.querySelector('[data-testid="project-chat"]')).toBeNull();
    expect(container.textContent).toContain('Merge similar topics first');
  });

  it.each([
    ['running', 'still being merged'],
    ['interrupted', 'stopped before it finished'],
    ['cancelled', 'was stopped'],
    ['error', 'failed'],
  ])('explains an incomplete %s merge', async (status, text) => {
    await render({ merge: { status, tree: null, eligiblePages: [] }, onOpenMerge: () => {} });
    expect(container.querySelector('.chat-panel-body').textContent).toContain(text);
    expect(buttons()).toContain('Open topic merge');
    expect(container.querySelector('[data-testid="project-chat"]')).toBeNull();
  });

  it('omits the merge button without a handler', async () => {
    await render({ merge: { status: 'missing', tree: null } });
    expect(buttons()).toEqual(['Hide']);
  });

  it('follows the merge prop as it changes and collapses', async () => {
    const onCollapse = vi.fn();
    await render({ merge: { status: 'running', tree: null }, onCollapse });
    expect(container.textContent).toContain('still being merged');
    await render({ merge: doneMerge(), onCollapse });
    const chat = container.querySelector('[data-testid="project-chat"]');
    expect(chat).not.toBeNull();
    await render({ merge: doneMerge({ stale: true }), onCollapse });
    expect(container.querySelector('[data-testid="project-chat"]')).toBe(chat);
    expect(container.querySelector('.chat-panel-notice')).not.toBeNull();
    await act(async () => container.querySelector('[aria-label="Collapse project chat"]').click());
    expect(onCollapse).toHaveBeenCalled();
  });
});
