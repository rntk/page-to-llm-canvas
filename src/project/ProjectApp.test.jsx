// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectApp } from './ProjectApp.jsx';

vi.mock('./ProjectChat.jsx', () => ({
  ProjectChat: ({ tree, stale, eligiblePages, skippedPages }) => (
    <div data-testid="project-chat" data-stale={String(stale)}>
      chat {tree.rootId} | {(eligiblePages || []).map((page) => page.title).join(',')} |{' '}
      {(skippedPages || []).map((page) => page.title).join(',')}
    </div>
  ),
}));

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

const viewOf = (overrides = {}) => ({
  project: { id: 'a', title: 'Work', color: 'blue' },
  isOpen: true,
  tabs: [
    { id: 1, title: 'First', url: 'https://a.test/x', active: true, status: 'complete' },
    { id: 2, title: '', url: 'https://b.test/y', status: 'loading' },
  ],
  ...overrides,
});

async function renderApp({ view = viewOf(), api, projectId = 'a', ...rest } = {}) {
  const resolvedApi = api || { getProjectView: vi.fn(async () => view) };
  const hosts = {
    tabsHost: { activateTab: vi.fn(async () => {}) },
    pageHost: { openOptions: vi.fn() },
  };
  await act(async () =>
    root.render(<ProjectApp projectId={projectId} api={resolvedApi} {...hosts} {...rest} />),
  );
  return { api: resolvedApi, ...hosts };
}

describe('ProjectApp', () => {
  it('shows a loading state before the view arrives', async () => {
    const api = { getProjectView: vi.fn(() => new Promise(() => {})) };
    await renderApp({ api });
    expect(container.textContent).toBe('Loading…');
  });

  it('shows a friendly error when the id is missing', async () => {
    const { api, pageHost } = await renderApp({ projectId: null });
    expect(api.getProjectView).not.toHaveBeenCalled();
    expect(container.querySelector('h1').textContent).toBe('No project selected');
    await act(async () => container.querySelector('button').click());
    expect(pageHost.openOptions).toHaveBeenCalled();
  });

  it('shows an error with an options link when the project cannot be loaded', async () => {
    const api = {
      getProjectView: vi.fn(async () => Promise.reject(new Error('project not found'))),
    };
    const { pageHost } = await renderApp({ api });
    expect(container.querySelector('[role="alert"]').textContent).toContain('project not found');
    await act(async () => container.querySelector('button').click());
    expect(pageHost.openOptions).toHaveBeenCalledTimes(1);
  });

  it('renders the header and real tab titles', async () => {
    await renderApp();
    expect(container.querySelector('h1').textContent).toBe('Work');
    expect(container.querySelector('.color-chip').dataset.color).toBe('blue');
    expect(container.querySelector('.project-meta').textContent).toBe('2 tabs');
    expect(container.querySelector('.status').textContent).toBe('Open');
    expect([...container.querySelectorAll('.tab-card-title')].map((n) => n.textContent)).toEqual([
      'First',
      'https://b.test/y',
    ]);
    expect(container.querySelector('.canvas-hint')).toBeNull();
    expect(document.title).toBe('Work · Project');
  });

  it('falls back to "Untitled project"', async () => {
    await renderApp({ view: viewOf({ project: { id: 'a', title: '', color: 'grey' } }) });
    expect(container.querySelector('h1').textContent).toBe('Untitled project');
    expect(document.title).toBe('Untitled project · Project');
  });

  it('shows the closed message with an empty canvas', async () => {
    await renderApp({ view: viewOf({ isOpen: false, tabs: [] }) });
    expect(container.querySelector('.canvas-hint').textContent).toBe(
      "This project's tab group is closed",
    );
    expect(container.querySelector('.status').textContent).toBe('Closed');
    expect(container.querySelectorAll('.tab-card')).toHaveLength(0);
  });

  it('hints to add tabs when the group is empty', async () => {
    await renderApp({ view: viewOf({ tabs: [] }) });
    expect(container.querySelector('.canvas-hint').textContent).toBe(
      'Add tabs to this tab group to see them here',
    );
  });

  it('"Go to tab" uses the injected tabs host', async () => {
    const { tabsHost } = await renderApp();
    const buttons = [...container.querySelectorAll('.tab-card button')];
    await act(async () => buttons[1].click());
    expect(tabsHost.activateTab).toHaveBeenCalledWith(2);
  });

  it('toggles the project chat panel', async () => {
    const view = viewOf({
      topicMerge: {
        status: 'done',
        tree: { rootId: 'root' },
        stale: false,
        eligiblePages: [],
        skippedPages: [],
      },
    });
    await renderApp({ view });
    const panel = () => container.querySelector('aside[aria-label="Project chat"]');
    expect(panel().querySelector('[data-testid="project-chat"]').textContent).toBe(
      'chat root |  | ',
    );
    await act(async () => panel().querySelector('button').click());
    expect(panel()).toBeNull();
    await act(async () => container.querySelector('.project-header button').click());
    expect(panel()).not.toBeNull();
  });

  it('opens the merge view from the chat panel when no merge exists yet', async () => {
    let view = viewOf({
      topicMerge: {
        status: 'missing',
        tree: null,
        eligiblePages: [{ key: 'a', title: 'First', url: 'https://a.test/x' }],
      },
    });
    const api = {
      getProjectView: vi.fn(async () => view),
      buildProjectTopicTree: vi.fn(async () => {
        view = { ...view, topicMerge: { ...view.topicMerge, status: 'running' } };
        return {};
      }),
    };
    await renderApp({ api });
    const panel = container.querySelector('aside[aria-label="Project chat"]');
    expect(panel.textContent).toContain('Merge similar topics first');
    await act(async () =>
      [...panel.querySelectorAll('button')]
        .find((el) => el.textContent === 'Merge similar topics')
        .click(),
    );
    expect(api.buildProjectTopicTree).toHaveBeenCalledWith('a', { fresh: false });
    expect(container.querySelector('[aria-label="Merged project topics"]')).not.toBeNull();
    // The chat follows the refreshed merge status.
    expect(panel.textContent).toContain('still being merged');
  });

  it('keeps the chat in sync with view.topicMerge, even when only the skipped pages differ', async () => {
    vi.useFakeTimers();
    try {
      let notify;
      const subscribe = vi.fn((cb) => {
        notify = cb;
        return () => {};
      });
      const merge = (overrides) => ({
        status: 'done',
        tree: { rootId: 'root', contentRevision: 'c1' },
        stale: false,
        eligiblePages: [{ title: 'Kept' }],
        skippedPages: [{ title: 'Draft one' }],
        ...overrides,
      });
      let view = viewOf({ topicMerge: merge() });
      const api = { getProjectView: vi.fn(async () => view) };
      await renderApp({ api, subscribe });
      const chat = () => container.querySelector('[data-testid="project-chat"]');
      expect(chat().textContent).toBe('chat root | Kept | Draft one');
      expect(chat().dataset.stale).toBe('false');
      const refresh = async () =>
        act(async () => {
          notify();
          vi.advanceTimersByTime(150);
        });

      view = viewOf({ topicMerge: merge({ skippedPages: [{ title: 'Draft two' }] }) });
      await refresh();
      expect(chat().textContent).toBe('chat root | Kept | Draft two');

      view = viewOf({ topicMerge: merge({ stale: true, skippedPages: [{ title: 'Draft two' }] }) });
      await refresh();
      expect(chat().dataset.stale).toBe('true');
      expect(api.getProjectView.mock.calls.length).toBeGreaterThan(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refetches on change notifications and unsubscribes on unmount', async () => {
    vi.useFakeTimers();
    try {
      let notify;
      const unsubscribe = vi.fn();
      const subscribe = vi.fn((cb) => {
        notify = cb;
        return unsubscribe;
      });
      let title = 'Before';
      const api = {
        getProjectView: vi.fn(async () =>
          viewOf({ tabs: [{ id: 1, title, url: 'https://a.test' }] }),
        ),
      };
      await renderApp({ api, subscribe });
      expect(container.querySelector('.tab-card-title').textContent).toBe('Before');
      title = 'After';
      await act(async () => {
        notify();
        vi.advanceTimersByTime(150);
      });
      expect(container.querySelector('.tab-card-title').textContent).toBe('After');
      act(() => root.unmount());
      expect(unsubscribe).toHaveBeenCalledTimes(1);
      root = createRoot(container);
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts a project merge from the actions menu and refreshes its background status', async () => {
    let view = viewOf({
      topicMerge: {
        status: 'missing',
        tree: null,
        eligiblePages: [{ key: 'a', title: 'First', url: 'https://a.test/x' }],
      },
    });
    const api = {
      getProjectView: vi.fn(async () => view),
      buildProjectTopicTree: vi.fn(async () => {
        view = {
          ...view,
          topicMerge: {
            ...view.topicMerge,
            status: 'running',
            tree: { status: 'running', stage: 'topics' },
          },
        };
        return {};
      }),
      stopProjectTopicTree: vi.fn(async () => ({})),
    };
    await renderApp({ api });
    const canvas = container.querySelector('.canvas-area');
    const toggle = container.querySelector('.project-actions__toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[role="menu"]')).toBeNull();
    await act(async () => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    await act(async () => container.querySelector('[role="menuitem"]').click());
    expect(api.buildProjectTopicTree).toHaveBeenCalledWith('a', { fresh: false });
    expect(api.getProjectView).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(container.querySelector('[aria-label="Merged project topics"]').textContent).toContain(
      'Merging similar topics',
    );
    await act(async () =>
      [...container.querySelectorAll('button')]
        .find((el) => el.getAttribute('role') === 'tab' && el.textContent === 'Canvas')
        .click(),
    );
    expect(container.querySelector('.canvas-area')).toBe(canvas);
    expect(container.querySelector('.project-canvas-content').classList.contains('is-hidden')).toBe(
      false,
    );
  });

  it('switches between the canvas and topics tree tabs without building', async () => {
    const api = {
      getProjectView: vi.fn(async () => viewOf({ topicMerge: { status: 'missing', tree: null } })),
      buildProjectTopicTree: vi.fn(async () => ({})),
    };
    await renderApp({ api });
    const tab = (name) =>
      [...container.querySelectorAll('[role="tab"]')].find((el) => el.textContent === name);
    expect(container.querySelector('.project-header .project-view-tabs')).not.toBeNull();
    const canvasPanel = container.querySelector('#project-panel-canvas');
    expect(canvasPanel.hidden).toBe(false);
    expect(tab('Canvas').getAttribute('aria-selected')).toBe('true');
    expect(container.querySelector('[aria-label="Merged project topics"]')).toBeNull();
    await act(async () => tab('Topics tree').click());
    expect(tab('Topics tree').getAttribute('aria-selected')).toBe('true');
    expect(canvasPanel.hidden).toBe(true);
    expect(
      container
        .querySelector('#project-panel-topics')
        .contains(container.querySelector('[aria-label="Merged project topics"]')),
    ).toBe(true);
    expect(container.querySelector('[aria-label="Merged project topics"]')).not.toBeNull();
    expect(api.buildProjectTopicTree).not.toHaveBeenCalled();
    await act(async () => tab('Canvas').click());
    expect(canvasPanel.hidden).toBe(false);
    expect(container.querySelector('#project-panel-topics')).toBeNull();
  });
});
