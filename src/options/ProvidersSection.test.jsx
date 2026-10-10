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

describe('decision provider form', () => {
  it('does not offer decision providers as the active completion provider', async () => {
    listProviders.mockResolvedValue({
      providers: [
        { id: 'decision', name: 'Decisions', type: 'llama_decision', model: '' },
        { id: 'completion', name: 'Completion', type: 'openai', model: 'gpt-4o' },
      ],
      activeId: 'completion',
      error: null,
    });
    const { container, mount, cleanup } = renderSection();
    try {
      await mount();
      const radios = Array.from(container.querySelectorAll('input[type="radio"]'));
      expect(radios).toHaveLength(1);
      expect(radios[0].getAttribute('aria-label')).toBe('Set Completion active');
      expect(container.querySelector('[aria-label="Set Decisions active"]')).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('selects the topic splitter explicitly', async () => {
    listProviders.mockResolvedValue({
      providers: [
        { id: 'decision', name: 'Decisions', type: 'llama_decision', model: '' },
        { id: 'completion', name: 'Completion', type: 'openai', model: 'gpt-4o' },
      ],
      activeId: 'completion',
      splitterId: null,
      error: null,
    });
    sendMessage.mockResolvedValue({ ok: true });
    const { container, mount, cleanup } = renderSection();
    try {
      await mount();
      const select = container.querySelector('#topic-splitter');
      expect(select.value).toBe('');
      expect(Array.from(select.options).map((option) => option.textContent)).toEqual([
        'Completion LLM',
        'Decisions',
      ]);
      await act(async () => {
        select.value = 'decision';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      expect(sendMessage).toHaveBeenCalledWith({ type: 'setTopicSplitter', id: 'decision' });
    } finally {
      cleanup();
    }
  });

  it('shows decision settings, saves an optional model, and hides temperature controls', async () => {
    listProviders.mockResolvedValue({ providers: [], activeId: null, error: null });
    sendMessage.mockResolvedValue({ ok: true });
    const { container, mount, cleanup } = renderSection();
    try {
      await mount();
      await act(async () => {
        Array.from(container.querySelectorAll('button'))
          .find((button) => button.textContent === 'Add provider')
          .click();
      });
      await act(async () => {
        const select = container.querySelector('#provider-type');
        select.value = 'llama_decision';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      expect(container.querySelector('#provider-url').placeholder).toBe('http://localhost:8080');
      expect(container.querySelector('#provider-model').placeholder).toBe('Server default');
      expect(container.textContent).toContain('Model (optional)');
      expect(container.textContent).toContain('cannot generate pipeline summaries or chat replies');
      expect(container.querySelector('#provider-temperature-chat')).toBeNull();
      await act(async () => {
        container
          .querySelector('form')
          .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: expect.objectContaining({ type: 'llama_decision', model: '' }),
        }),
      );
    } finally {
      cleanup();
    }
  });
});
