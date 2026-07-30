// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('./trustedEvents.js', () => ({
  guardTrustedUserEvent: vi.fn((event) => {
    const blocked = event?.blocked === true || event?.nativeEvent?.blocked === true;
    if (blocked) {
      event.preventDefault?.();
      event.stopPropagation?.();
      return false;
    }
    return true;
  }),
}));

vi.mock('../shared/surfacePreferences.js', () => ({
  applyContentTheme: vi.fn(),
  applyContentHighlightColor: vi.fn(),
  trackMountedSurface: vi.fn(),
  untrackMountedSurface: vi.fn(),
  registerThemedSurface: vi.fn(),
}));

vi.stubGlobal('chrome', {
  runtime: {
    sendMessage: vi.fn(),
    lastError: null,
  },
  storage: {
    local: {
      get: vi.fn((_key, callback) => callback({})),
    },
    onChanged: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
  },
});

const { showSelectionToolbar } = await import('./controller.jsx');

function toolbarRoot() {
  return window.__pagetollmTestSelectionToolbarRoot;
}

function toolbarButton(id) {
  return toolbarRoot()?.querySelector(`#${id}`);
}

function event(type, blocked = false) {
  const result = new MouseEvent(type, { bubbles: true, cancelable: true });
  Object.defineProperty(result, 'blocked', { value: blocked });
  return result;
}

function click(element, blocked = false) {
  act(() => element.dispatchEvent(event('click', blocked)));
}

function mountBlock(id, text = 'Selected content') {
  const block = document.createElement('article');
  block.id = id;
  block.textContent = text;
  document.body.appendChild(block);
  return block;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('selection controller', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.stubGlobal('alert', vi.fn());
    vi.stubGlobal('console', { ...console, error: vi.fn() });
    chrome.runtime.sendMessage.mockReset();
    chrome.runtime.sendMessage.mockResolvedValue({ ok: true });
    window.history.replaceState({}, '', '/article');
  });

  afterEach(async () => {
    const cancel = toolbarButton('pagetollm-cancel-btn');
    if (cancel) {
      await act(async () => click(cancel));
    }
    document.body.innerHTML = '';
  });

  it('creates a toolbar, replaces the existing one, and cleans it up', () => {
    act(() => showSelectionToolbar());
    const first = document.getElementById('pagetollm-selection-toolbar');
    const firstRoot = toolbarRoot();

    expect(first).not.toBeNull();
    expect(firstRoot).not.toBeNull();
    expect(document.querySelectorAll('#pagetollm-selection-toolbar')).toHaveLength(1);

    act(() => showSelectionToolbar());
    expect(document.querySelectorAll('#pagetollm-selection-toolbar')).toHaveLength(1);
    expect(document.getElementById('pagetollm-selection-toolbar')).not.toBe(first);
    expect(toolbarRoot()).not.toBe(firstRoot);

    act(() => click(toolbarButton('pagetollm-cancel-btn')));
    expect(document.getElementById('pagetollm-selection-toolbar')).toBeNull();
    expect(window.__pagetollmTestSelectionToolbarRoot).toBeNull();
  });

  it('gates blocked toolbar and page events', () => {
    const block = mountBlock('blocked');
    act(() => showSelectionToolbar());

    click(toolbarButton('pagetollm-pick-btn'), true);
    expect(toolbarButton('pagetollm-pick-btn').textContent).toBe('Pick Block');

    click(toolbarButton('pagetollm-pick-btn'));
    expect(toolbarButton('pagetollm-pick-btn').textContent).toBe('Picking...');

    block.dispatchEvent(event('click', true));
    expect(block.classList.contains('pagetollm-selected')).toBe(false);
    expect(toolbarRoot().querySelectorAll('.pagetollm-block-item')).toHaveLength(0);
  });

  it('enters picking mode, highlights and selects a page block', () => {
    const block = mountBlock('picked', 'Hello selection');
    act(() => showSelectionToolbar());
    click(toolbarButton('pagetollm-pick-btn'));

    block.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    expect(block.classList.contains('pagetollm-element-highlight')).toBe(true);

    act(() => block.dispatchEvent(event('click')));
    expect(block.classList.contains('pagetollm-selected')).toBe(true);
    expect(toolbarButton('pagetollm-pick-btn').textContent).toBe('Pick Block');
    expect(toolbarButton('pagetollm-submit-btn').textContent).toBe('Submit (1)');
    expect(toolbarRoot().querySelectorAll('.pagetollm-block-item')).toHaveLength(1);
  });

  it('submits selected HTML and selectors successfully, then cleans up', async () => {
    const block = mountBlock('submitted', 'Submit me');
    act(() => showSelectionToolbar());
    click(toolbarButton('pagetollm-pick-btn'));
    act(() => block.dispatchEvent(event('click')));

    await act(async () => click(toolbarButton('pagetollm-submit-btn')));
    await flush();

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'submit',
      html: '<article id="submitted" class="">Submit me</article>',
      sourceUrl: expect.stringContaining('/article'),
      selectors: ['article#submitted'],
    });
    expect(document.getElementById('pagetollm-selection-toolbar')).toBeNull();
    expect(block.classList.contains('pagetollm-selected')).toBe(false);
  });

  it('alerts on submission failure and still cleans up', async () => {
    const block = mountBlock('failed', 'Fail me');
    chrome.runtime.sendMessage.mockResolvedValue({ ok: false, error: 'network down' });
    act(() => showSelectionToolbar());
    click(toolbarButton('pagetollm-pick-btn'));
    act(() => block.dispatchEvent(event('click')));

    await act(async () => click(toolbarButton('pagetollm-submit-btn')));
    await flush();

    expect(alert).toHaveBeenCalledWith('PageToLLM error: network down');
    expect(document.getElementById('pagetollm-selection-toolbar')).toBeNull();
  });

  it('alerts instead of sending when submission has no selection', async () => {
    act(() => showSelectionToolbar());
    const submit = toolbarButton('pagetollm-submit-btn');
    const reactPropsKey = Object.keys(submit).find((key) => key.startsWith('__reactProps'));

    await act(async () => {
      await submit[reactPropsKey].onClick(event('click'));
    });

    expect(alert).toHaveBeenCalledWith('Please pick at least one block first.');
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
    expect(document.getElementById('pagetollm-selection-toolbar')).not.toBeNull();
  });
});
