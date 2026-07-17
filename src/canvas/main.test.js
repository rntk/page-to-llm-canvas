// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';

vi.mock('./App.jsx', () => ({
  default: vi.fn(() => React.createElement('div', { 'data-testid': 'app' })),
}));

vi.mock('../hierarchy/HierarchyApp.jsx', () => ({
  default: vi.fn(() => React.createElement('div', { 'data-testid': 'hierarchy-app' })),
}));

describe('main.jsx entry point', () => {
  beforeEach(() => {
    vi.resetModules();
    const rootEl = document.createElement('div');
    rootEl.id = 'pagetollm-root';
    document.body.appendChild(rootEl);
  });

  afterEach(() => {
    const rootEl = document.getElementById('pagetollm-root');
    if (rootEl) rootEl.remove();
    vi.unstubAllGlobals();
  });

  it('renders HierarchyApp when view is hierarchy', async () => {
    vi.stubGlobal('location', {
      search: '?key=key-hier&view=hierarchy',
    });

    await import('./main.jsx');

    await new Promise((resolve) => setTimeout(resolve, 10));

    const HierarchyAppMock = (await import('../hierarchy/HierarchyApp.jsx')).default;
    expect(HierarchyAppMock).toHaveBeenCalledWith(
      expect.objectContaining({ initialKey: 'key-hier' }),
      undefined,
    );
  });

  it('renders App by default', async () => {
    vi.stubGlobal('location', {
      search: '?key=key-app',
    });

    await import('./main.jsx');

    await new Promise((resolve) => setTimeout(resolve, 10));

    const AppMock = (await import('./App.jsx')).default;
    expect(AppMock).toHaveBeenCalledWith(
      expect.objectContaining({ initialKey: 'key-app' }),
      undefined,
    );
  });
});
