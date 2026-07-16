// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStoredPreference } from './useStoredPreference.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function renderPreferenceHook(options) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const result = { current: null };
  let mounted = true;

  function Harness() {
    result.current = useStoredPreference(options);
    return null;
  }

  act(() => root.render(createElement(Harness)));
  return {
    result,
    unmount() {
      if (!mounted) return;
      mounted = false;
      act(() => root.unmount());
      container.remove();
    },
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

const cleanups = [];
let changeListeners;

beforeEach(() => {
  changeListeners = [];
  vi.stubGlobal('chrome', {
    storage: {
      onChanged: {
        addListener: vi.fn((listener) => changeListeners.push(listener)),
        removeListener: vi.fn((listener) => {
          const index = changeListeners.indexOf(listener);
          if (index !== -1) changeListeners.splice(index, 1);
        }),
      },
    },
  });
});

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.unstubAllGlobals();
});

function setup(overrides = {}) {
  const options = {
    storageKey: 'preference-key',
    defaultValue: false,
    readPreference: vi.fn().mockResolvedValue(false),
    writePreference: vi.fn().mockResolvedValue(false),
    normalize: (value) => value === true,
    ...overrides,
  };
  const rendered = renderPreferenceHook(options);
  cleanups.push(rendered.unmount);
  return { ...rendered, options };
}

describe('useStoredPreference', () => {
  it('loads and normalizes the stored value', async () => {
    const normalize = vi.fn((value) => value === 'enabled');
    const { result, options } = setup({
      readPreference: vi.fn().mockResolvedValue('enabled'),
      normalize,
    });

    expect(result.current[0]).toBe(false);
    await flush();

    expect(options.readPreference).toHaveBeenCalledTimes(1);
    expect(normalize).toHaveBeenCalledWith('enabled');
    expect(result.current[0]).toBe(true);
  });

  it('keeps the default value when the initial reader rejects', async () => {
    const { result } = setup({
      defaultValue: true,
      readPreference: vi.fn().mockRejectedValue(new Error('storage unavailable')),
    });

    await flush();

    expect(result.current[0]).toBe(true);
  });

  it('reacts only to matching local storage changes and normalizes their values', () => {
    const normalize = vi.fn((value) => value === 'on');
    const { result } = setup({ normalize });
    const listener = changeListeners[0];

    act(() => listener({ 'other-key': { newValue: 'on' } }, 'local'));
    act(() => listener({ 'preference-key': { newValue: 'on' } }, 'sync'));
    expect(result.current[0]).toBe(false);

    act(() => listener({ 'preference-key': { newValue: 'on' } }, 'local'));
    expect(result.current[0]).toBe(true);
    expect(normalize).toHaveBeenLastCalledWith('on');
  });

  it('updates optimistically and rolls back to storage when persistence fails', async () => {
    const failedWrite = deferred();
    const readPreference = vi.fn().mockResolvedValue(false);
    const writePreference = vi.fn(() => failedWrite.promise);
    const { result } = setup({ readPreference, writePreference });
    await flush();

    let update;
    act(() => {
      update = result.current[1](true);
    });
    expect(result.current[0]).toBe(true);
    expect(writePreference).toHaveBeenCalledWith(true);

    failedWrite.reject(new Error('storage failed'));
    await act(async () => update);

    expect(readPreference).toHaveBeenCalledTimes(2);
    expect(result.current[0]).toBe(false);
  });

  it('does not let a stale initial load overwrite a newer optimistic update', async () => {
    const initialLoad = deferred();
    const { result } = setup({
      readPreference: vi.fn(() => initialLoad.promise),
      writePreference: vi.fn().mockResolvedValue(true),
    });
    await flush();

    await act(async () => result.current[1](true));
    expect(result.current[0]).toBe(true);

    initialLoad.resolve(false);
    await flush();
    expect(result.current[0]).toBe(true);
  });

  it('ignores a pending load after unmount and removes the exact listener', async () => {
    const pendingLoad = deferred();
    const normalize = vi.fn((value) => value === true);
    const { unmount } = setup({
      readPreference: vi.fn(() => pendingLoad.promise),
      normalize,
    });
    await flush();
    const listener = changeListeners[0];

    unmount();
    expect(chrome.storage.onChanged.removeListener).toHaveBeenCalledWith(listener);
    expect(changeListeners).toHaveLength(0);

    pendingLoad.resolve(true);
    await flush();
    expect(normalize).not.toHaveBeenCalled();
  });
});
