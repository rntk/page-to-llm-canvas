// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectApp } from './ProjectApp.jsx';

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

  it('toggles the disabled project chat panel', async () => {
    await renderApp();
    const panel = () => container.querySelector('aside[aria-label="Project chat"]');
    expect(panel().textContent).toContain('Coming soon — chat across all pages in this project');
    expect(panel().querySelector('textarea').disabled).toBe(true);
    await act(async () => panel().querySelector('button').click());
    expect(panel()).toBeNull();
    await act(async () => container.querySelector('.project-header button').click());
    expect(panel()).not.toBeNull();
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
});
