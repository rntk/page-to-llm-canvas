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

async function openAddForm(container) {
  await act(async () => {
    Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === 'Add provider')
      .click();
  });
}

function submitForm(container) {
  container
    .querySelector('form')
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

describe('provider form submit guard', () => {
  it('sends a single save for two rapid submits and disables the button while saving', async () => {
    listProviders.mockResolvedValue({ providers: [], activeId: null, error: null });
    let resolveSave;
    sendMessage.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
    );
    const { container, mount, cleanup } = renderSection();
    try {
      await mount();
      await openAddForm(container);
      await act(async () => {
        submitForm(container);
        submitForm(container);
      });
      expect(sendMessage.mock.calls.filter(([msg]) => msg.type === 'saveProvider')).toHaveLength(1);
      expect(container.querySelector('button[type="submit"]').disabled).toBe(true);

      await act(async () => {
        resolveSave({ ok: true });
      });
      expect(container.querySelector('form')).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('re-enables submit after a failed save so the user can retry', async () => {
    listProviders.mockResolvedValue({ providers: [], activeId: null, error: null });
    sendMessage.mockResolvedValueOnce({ ok: false, error: 'boom' });
    const { container, mount, cleanup } = renderSection();
    try {
      await mount();
      await openAddForm(container);
      await act(async () => {
        submitForm(container);
      });
      expect(container.textContent).toContain('boom');
      expect(container.querySelector('button[type="submit"]').disabled).toBe(false);
    } finally {
      cleanup();
    }
  });
});

function typeInto(input, value) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('provider form unsaved-changes and token-wipe UX', () => {
  const stored = [
    { id: 'p1', name: 'One', type: 'openai', model: 'gpt-4o', hasToken: true },
    { id: 'p2', name: 'Two', type: 'openai', model: 'gpt-4o', hasToken: false },
  ];
  const clickButton = (container, label, index = 0) =>
    Array.from(container.querySelectorAll('button')).filter((b) => b.textContent === label)[index];

  it('asks before discarding a dirty form on edit, and keeps the form when declined', async () => {
    listProviders.mockResolvedValue({ providers: stored, activeId: 'p1', error: null });
    const confirmMock = vi.fn(() => false);
    vi.stubGlobal('confirm', confirmMock);
    const { container, mount, cleanup } = renderSection();
    try {
      await mount();
      await act(async () => clickButton(container, 'Edit', 0).click());
      // Pristine form: switching does not prompt.
      await act(async () => clickButton(container, 'Edit', 1).click());
      expect(confirmMock).not.toHaveBeenCalled();
      expect(container.querySelector('#provider-name').value).toBe('Two');

      await act(async () => typeInto(container.querySelector('#provider-token'), 'sk-secret'));
      await act(async () => clickButton(container, 'Edit', 0).click());
      expect(confirmMock).toHaveBeenCalledTimes(1);
      expect(container.querySelector('#provider-name').value).toBe('Two');
      expect(container.querySelector('#provider-token').value).toBe('sk-secret');

      confirmMock.mockReturnValue(true);
      await act(async () => clickButton(container, 'Edit', 0).click());
      expect(container.querySelector('#provider-name').value).toBe('One');
      expect(container.querySelector('#provider-token').value).toBe('');
    } finally {
      cleanup();
      vi.unstubAllGlobals();
    }
  });

  it('asks before add() discards a dirty edit form', async () => {
    listProviders.mockResolvedValue({ providers: stored, activeId: 'p1', error: null });
    const confirmMock = vi.fn(() => false);
    vi.stubGlobal('confirm', confirmMock);
    const { container, mount, cleanup } = renderSection();
    try {
      await mount();
      await act(async () => clickButton(container, 'Edit', 0).click());
      await act(async () => typeInto(container.querySelector('#provider-name'), 'Renamed'));
      await act(async () => clickButton(container, 'Add provider').click());
      expect(confirmMock).toHaveBeenCalledTimes(1);
      expect(container.querySelector('#provider-name').value).toBe('Renamed');
    } finally {
      cleanup();
      vi.unstubAllGlobals();
    }
  });

  it('warns about token wipe and swaps the "Leave blank" note when the type changes', async () => {
    listProviders.mockResolvedValue({ providers: stored, activeId: 'p1', error: null });
    sendMessage.mockResolvedValue({ ok: true });
    const confirmMock = vi.fn(() => false);
    vi.stubGlobal('confirm', confirmMock);
    const { container, mount, cleanup } = renderSection();
    try {
      await mount();
      await act(async () => clickButton(container, 'Edit', 0).click());
      expect(container.querySelector('#provider-token-note').textContent).toContain(
        'Leave blank to keep the stored token',
      );
      await act(async () => {
        const select = container.querySelector('#provider-type');
        select.value = 'anthropic';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      const note = container.querySelector('#provider-token-note').textContent;
      expect(note).not.toContain('Leave blank');
      expect(note).toContain('removes the stored token');

      await act(async () => submitForm(container));
      expect(confirmMock).toHaveBeenCalledWith(expect.stringContaining('provider type'));
      expect(sendMessage).not.toHaveBeenCalled();

      confirmMock.mockReturnValue(true);
      await act(async () => submitForm(container));
      expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'saveProvider' }));
    } finally {
      cleanup();
      vi.unstubAllGlobals();
    }
  });
});
