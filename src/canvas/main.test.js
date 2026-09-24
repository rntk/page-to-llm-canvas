// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { act } from 'react';

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

    await act(async () => {
      await import('./main.jsx');
    });

    const HierarchyAppMock = (await import('../hierarchy/HierarchyApp.jsx')).default;
    expect(HierarchyAppMock).toHaveBeenCalledWith(
      expect.objectContaining({
        initialKey: 'key-hier',
        onClose: expect.any(Function),
        onNavigateToSentences: expect.any(Function),
      }),
      undefined,
    );
  });

  it('renders App by default', async () => {
    vi.stubGlobal('location', {
      search: '?key=key-app',
    });

    await act(async () => {
      await import('./main.jsx');
    });

    const AppMock = (await import('./App.jsx')).default;
    expect(AppMock).toHaveBeenCalledWith(
      expect.objectContaining({ initialKey: 'key-app', onClose: expect.any(Function) }),
      undefined,
    );
  });
});
