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

const { createSelectionController } = await import('./controller.jsx');
const runtimeMessenger = { send: vi.fn() };
let activeController = null;

function showSelectionToolbar(messenger) {
  activeController?.destroy();
  activeController = createSelectionController({
    document,
    window,
    runtimeMessenger: messenger,
    dialogs: { alert },
    onDestroy: () => {
      activeController = null;
    },
  });
}

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
    runtimeMessenger.send.mockReset().mockResolvedValue({ ok: true });
    window.history.replaceState({}, '', '/article');
  });

  afterEach(async () => {
    const cancel = toolbarButton('pagetollm-cancel-btn');
    if (cancel) {
      await act(async () => click(cancel));
    }
    activeController?.destroy();
    activeController = null;
    document.body.innerHTML = '';
  });

  it('uses browser-backed defaults when optional dependencies are omitted', () => {
    let controller;
    expect(() => {
      controller = createSelectionController();
    }).not.toThrow();

    act(() => controller.destroy());
    expect(document.getElementById('pagetollm-selection-toolbar')).toBeNull();
  });

  it('creates a toolbar, replaces the existing one, and cleans it up', () => {
    act(() => showSelectionToolbar(runtimeMessenger));
    const first = document.getElementById('pagetollm-selection-toolbar');
    const firstRoot = toolbarRoot();

    expect(first).not.toBeNull();
    expect(firstRoot).not.toBeNull();
    expect(document.querySelectorAll('#pagetollm-selection-toolbar')).toHaveLength(1);

    act(() => showSelectionToolbar(runtimeMessenger));
    expect(document.querySelectorAll('#pagetollm-selection-toolbar')).toHaveLength(1);
    expect(document.getElementById('pagetollm-selection-toolbar')).not.toBe(first);
    expect(toolbarRoot()).not.toBe(firstRoot);

    act(() => click(toolbarButton('pagetollm-cancel-btn')));
    expect(document.getElementById('pagetollm-selection-toolbar')).toBeNull();
    expect(window.__pagetollmTestSelectionToolbarRoot).toBeNull();
  });

  it('gates blocked toolbar and page events', () => {
    const block = mountBlock('blocked');
    act(() => showSelectionToolbar(runtimeMessenger));

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
    act(() => showSelectionToolbar(runtimeMessenger));
    click(toolbarButton('pagetollm-pick-btn'));

    block.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    expect(block.classList.contains('pagetollm-element-highlight')).toBe(true);

    act(() => block.dispatchEvent(event('click')));
    expect(block.classList.contains('pagetollm-selected')).toBe(true);
    expect(toolbarButton('pagetollm-pick-btn').textContent).toBe('Pick Block');
    expect(toolbarButton('pagetollm-submit-btn').textContent).toBe('Submit (1)');
    expect(toolbarRoot().querySelectorAll('.pagetollm-block-item')).toHaveLength(1);
  });

  it('keeps selected markers in sync after stepping up and removing a block', () => {
    const parent = mountBlock('parent');
    const child = document.createElement('div');
    parent.appendChild(child);
    act(() => showSelectionToolbar(runtimeMessenger));

    click(toolbarButton('pagetollm-pick-btn'));
    act(() => child.dispatchEvent(event('click')));
    click(toolbarButton('pagetollm-pick-btn'));

    child.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    child.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    expect(child.classList.contains('pagetollm-element-highlight')).toBe(true);

    click(toolbarRoot().querySelector('.pagetollm-stepup-btn'));
    child.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    parent.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    parent.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    expect(child.classList.contains('pagetollm-element-highlight')).toBe(false);
    expect(parent.classList.contains('pagetollm-element-highlight')).toBe(true);

    click(toolbarRoot().querySelector('.pagetollm-remove-btn'));
    parent.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    expect(parent.classList.contains('pagetollm-element-highlight')).toBe(false);
  });

  it('keeps the selected marker until the last duplicate entry is removed', () => {
    const block = mountBlock('duplicate');
    act(() => showSelectionToolbar(runtimeMessenger));

    click(toolbarButton('pagetollm-pick-btn'));
    act(() => block.dispatchEvent(event('click')));
    click(toolbarButton('pagetollm-pick-btn'));
    act(() => block.dispatchEvent(event('click')));
    expect(toolbarButton('pagetollm-submit-btn').textContent).toBe('Submit (2)');

    click(toolbarButton('pagetollm-pick-btn'));
    block.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    click(toolbarRoot().querySelector('.pagetollm-remove-btn'));
    block.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    expect(block.classList.contains('pagetollm-selected')).toBe(true);
    expect(block.classList.contains('pagetollm-element-highlight')).toBe(true);

    click(toolbarRoot().querySelector('.pagetollm-remove-btn'));
    block.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    expect(block.classList.contains('pagetollm-selected')).toBe(false);
    expect(block.classList.contains('pagetollm-element-highlight')).toBe(false);
  });

  it('submits selected HTML and selectors successfully, then cleans up', async () => {
    const block = mountBlock('submitted', 'Submit me');
    act(() => showSelectionToolbar(runtimeMessenger));
    click(toolbarButton('pagetollm-pick-btn'));
    act(() => block.dispatchEvent(event('click')));

    await act(async () => click(toolbarButton('pagetollm-submit-btn')));
    await flush();

    expect(runtimeMessenger.send).toHaveBeenCalledWith({
      type: 'submit',
      html: '<article id="submitted" class="">Submit me</article>',
      capturedText: 'Submit me',
      captureVersion: 2,
      sourceUrl: expect.stringContaining('/article'),
      selectors: ['article#submitted'],
    });
    expect(document.getElementById('pagetollm-selection-toolbar')).toBeNull();
    expect(block.classList.contains('pagetollm-selected')).toBe(false);
  });

  it('alerts on submission failure and still cleans up', async () => {
    const block = mountBlock('failed', 'Fail me');
    runtimeMessenger.send.mockResolvedValue({ ok: false, error: 'network down' });
    act(() => showSelectionToolbar(runtimeMessenger));
    click(toolbarButton('pagetollm-pick-btn'));
    act(() => block.dispatchEvent(event('click')));

    await act(async () => click(toolbarButton('pagetollm-submit-btn')));
    await flush();

    expect(alert).toHaveBeenCalledWith('PageToLLM error: network down');
    expect(document.getElementById('pagetollm-selection-toolbar')).toBeNull();
  });

  it('alerts instead of sending when submission has no selection', async () => {
    act(() => showSelectionToolbar(runtimeMessenger));
    const submit = toolbarButton('pagetollm-submit-btn');
    const reactPropsKey = Object.keys(submit).find((key) => key.startsWith('__reactProps'));

    await act(async () => {
      await submit[reactPropsKey].onClick(event('click'));
    });

    expect(alert).toHaveBeenCalledWith('Please pick at least one block first.');
    expect(runtimeMessenger.send).not.toHaveBeenCalled();
    expect(document.getElementById('pagetollm-selection-toolbar')).not.toBeNull();
  });
});
