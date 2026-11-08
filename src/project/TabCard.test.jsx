// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TabCard } from './TabCard.jsx';

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

const tab = (overrides = {}) => ({
  id: 7,
  title: 'Docs home',
  url: 'https://www.example.com/docs',
  favIconUrl: 'https://www.example.com/icon.png',
  active: false,
  status: 'complete',
  ...overrides,
});

const render = (props) => act(async () => root.render(<TabCard tabsHost={{}} {...props} />));

describe('TabCard', () => {
  it('shows the real title, hostname and placeholder body', async () => {
    await render({ tab: tab() });
    expect(container.querySelector('.tab-card-title').textContent).toBe('Docs home');
    expect(container.querySelector('.tab-card-host').textContent).toBe('www.example.com');
    expect(container.textContent).toContain('Page content will appear here');
    expect(container.querySelector('img.tab-card-favicon').getAttribute('src')).toBe(
      'https://www.example.com/icon.png',
    );
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector('.tab-card.is-active')).toBeNull();
  });

  it('falls back to a letter tile without a favicon or when it fails to load', async () => {
    await render({ tab: tab({ favIconUrl: '' }) });
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.tab-card-favicon-fallback').textContent).toBe('E');

    await render({ tab: tab() });
    await act(async () => {
      container.querySelector('img').dispatchEvent(new Event('error'));
    });
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.tab-card-favicon-fallback')).not.toBeNull();
  });

  it('marks the active tab and the loading state', async () => {
    await render({ tab: tab({ active: true, status: 'loading' }) });
    expect(container.querySelector('.tab-card.is-active')).not.toBeNull();
    expect(container.querySelector('[role="status"]')).not.toBeNull();
  });

  it('falls back to the url when the title is empty', async () => {
    await render({ tab: tab({ title: '' }) });
    expect(container.querySelector('.tab-card-title').textContent).toBe(
      'https://www.example.com/docs',
    );
  });

  it('"Go to tab" asks the host to activate the tab', async () => {
    const tabsHost = { activateTab: vi.fn(async () => {}) };
    await render({ tab: tab(), tabsHost });
    await act(async () => container.querySelector('button').click());
    expect(tabsHost.activateTab).toHaveBeenCalledWith(7);
  });

  it('reports an async activation rejection and clears it after a successful retry', async () => {
    const tabsHost = {
      activateTab: vi.fn().mockRejectedValueOnce(new Error('no tab')).mockResolvedValueOnce(),
    };
    await render({ tab: tab(), tabsHost });
    await act(async () => container.querySelector('button').click());
    expect(container.querySelector('.tab-card-error').textContent).toBe('Could not switch to tab');
    await act(async () => container.querySelector('button').click());
    expect(container.querySelector('.tab-card-error')).toBeNull();
  });

  it('reports synchronous activation errors and clears them after a successful retry', async () => {
    const tabsHost = {
      activateTab: vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error('no tab');
        })
        .mockResolvedValueOnce(),
    };
    await render({ tab: tab(), tabsHost });
    await act(async () => container.querySelector('button').click());
    expect(container.querySelector('.tab-card-error').textContent).toBe('Could not switch to tab');
    await act(async () => container.querySelector('button').click());
    expect(container.querySelector('.tab-card-error')).toBeNull();
  });
});
