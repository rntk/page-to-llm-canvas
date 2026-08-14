// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useStoredMetrics } from './useStoredMetrics.js';

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function renderMetrics(options) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const result = { current: null };
  function Harness() {
    result.current = useStoredMetrics(options);
    return null;
  }
  act(() => root.render(createElement(Harness)));
  return {
    result,
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

describe('useStoredMetrics', () => {
  it('does not let a stale initial read overwrite a newer subscription value', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const initialRead = deferred();
    let publish;
    const unsubscribe = vi.fn();
    const subscribe = vi.fn((_key, listener) => {
      publish = listener;
      return unsubscribe;
    });
    const rendered = renderMetrics({
      storageKey: 'metrics',
      read: () => initialRead.promise,
      normalize: (value) => ({ count: Number(value?.count) || 0 }),
      empty: () => ({ count: 0 }),
      subscribe,
    });

    act(() => publish({ count: 2 }));
    expect(rendered.result.current[0]).toEqual({ count: 2 });

    initialRead.resolve({ count: 1 });
    await flush();
    expect(rendered.result.current[0]).toEqual({ count: 2 });

    rendered.unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('ignores an initial read after unmount', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const initialRead = deferred();
    const unsubscribe = vi.fn();
    const rendered = renderMetrics({
      storageKey: 'metrics',
      read: () => initialRead.promise,
      normalize: vi.fn((value) => value),
      empty: () => ({ count: 0 }),
      subscribe: () => unsubscribe,
    });

    rendered.unmount();
    initialRead.resolve({ count: 1 });
    await flush();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('does not let a stale initial read overwrite a local clear', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const initialRead = deferred();
    const rendered = renderMetrics({
      storageKey: 'metrics',
      read: () => initialRead.promise,
      normalize: (value) => value,
      empty: () => ({ count: 0 }),
      subscribe: () => () => {},
    });

    act(() => rendered.result.current[1]({ count: 0 }));
    initialRead.resolve({ count: 5 });
    await flush();
    expect(rendered.result.current[0]).toEqual({ count: 0 });
    rendered.unmount();
  });
});
