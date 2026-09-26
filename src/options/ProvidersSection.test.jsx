// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listProviders = vi.hoisted(() => vi.fn());
const sendMessage = vi.hoisted(() => vi.fn());
vi.mock('./optionsApi.js', () => ({ listProviders, sendMessage }));

import { ProvidersSection } from './ProvidersSection.jsx';

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  listProviders.mockReset();
  sendMessage.mockReset();
});

afterEach(() => {
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

async function waitFor(assertion, timeout = 1000) {
  const start = Date.now();
  let lastError;
  while (Date.now() - start < timeout) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}

function renderSection() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  return {
    container,
    cleanup() {
      act(() => root.unmount());
      container.remove();
    },
    async mount() {
      await act(async () => {
        root.render(<ProvidersSection />);
      });
    },
  };
}

function findRetry(container) {
  return Array.from(container.querySelectorAll('button')).find(
    (button) => button.textContent === 'Retry',
  );
}

describe('ProvidersSection retry banners', () => {
  it('shows a load-failure banner with Retry instead of the empty state, and recovers on retry', async () => {
    listProviders.mockResolvedValueOnce({
      providers: null,
      activeId: null,
      error: 'storage read failed',
    });
    const { container, mount, cleanup } = renderSection();
    try {
      await mount();
      await waitFor(() => {
        expect(container.textContent).toContain("Couldn't load providers: storage read failed");
      });
      expect(container.textContent).not.toContain('No providers configured yet');
      expect(findRetry(container)).not.toBeUndefined();

      listProviders.mockResolvedValueOnce({ providers: [], activeId: null, error: null });
      await act(async () => {
        findRetry(container).click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await waitFor(() => {
        expect(container.textContent).toContain('No providers configured yet');
      });
      expect(container.textContent).not.toContain("Couldn't load providers");
      expect(listProviders).toHaveBeenCalledTimes(2);
    } finally {
      cleanup();
    }
  });

  it('keeps the provider list visible behind a refresh-failure banner, and clears it on retry', async () => {
    const stored = [
      { id: 'p1', name: 'Local', type: 'openai', model: 'm' },
      { id: 'p2', name: 'Remote', type: 'openai', model: 'm' },
    ];
    listProviders.mockResolvedValueOnce({ providers: stored, activeId: 'p1', error: null });
    const { container, mount, cleanup } = renderSection();
    try {
      await mount();
      await waitFor(() => {
        expect(container.querySelector('tbody tr')).not.toBeNull();
      });

      // A later reload (here via activating a provider) fails: the stale list
      // must stay visible behind a "refresh" banner, not collapse to empty.
      listProviders.mockResolvedValueOnce({
        providers: null,
        activeId: null,
        error: 'refresh failed',
      });
      sendMessage.mockResolvedValueOnce({ ok: true });
      await act(async () => {
        container.querySelector('input[aria-label="Set Remote active"]').click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await waitFor(() => {
        expect(container.textContent).toContain("Couldn't refresh providers: refresh failed");
      });
      expect(container.querySelector('tbody tr').textContent).toContain('Local');
      expect(container.textContent).not.toContain('No providers configured yet');

      listProviders.mockResolvedValueOnce({ providers: stored, activeId: 'p1', error: null });
      await act(async () => {
        findRetry(container).click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await waitFor(() => {
        expect(container.textContent).not.toContain("Couldn't refresh providers");
      });
      expect(container.querySelector('tbody tr').textContent).toContain('Local');
    } finally {
      cleanup();
    }
  });
});
