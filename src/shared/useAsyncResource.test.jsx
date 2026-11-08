// @vitest-environment happy-dom
import React, { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAsyncResource } from './useAsyncResource.js';

let root;
let container;
let latest;

function Harness({ resourceKey, load }) {
  const value = useAsyncResource(resourceKey, load);
  useEffect(() => {
    latest = value;
  });
  return null;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function render(resourceKey, load) {
  await act(async () => root.render(<Harness resourceKey={resourceKey} load={load} />));
}

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

describe('useAsyncResource', () => {
  it('handles synchronous throws and non-Error rejections', async () => {
    const throws = () => {
      throw new Error('sync failure');
    };
    await render('a', throws);
    expect(latest).toMatchObject({ status: 'error', data: null, error: 'sync failure' });
    await render('a', () => Promise.reject(0));
    expect(latest).toMatchObject({ status: 'error', data: null, error: '0' });
    await render('a', () => Promise.reject(''));
    expect(latest).toMatchObject({ status: 'error', data: null, error: '' });
  });

  it('shows loading when the key, loader or reload changes', async () => {
    const first = vi.fn().mockResolvedValue('first');
    await render('a', first);
    expect(latest).toMatchObject({ status: 'ready', data: 'first' });
    const pending = deferred();
    const second = vi.fn().mockReturnValue(pending.promise);
    first.mockReturnValue(pending.promise);
    await render('b', first);
    expect(latest).toMatchObject({ status: 'loading', data: null, error: null });
    await render('b', second);
    expect(latest).toMatchObject({ status: 'loading', data: null, error: null });
    await act(async () => pending.resolve('second'));
    expect(latest).toMatchObject({ status: 'ready', data: 'second' });
    const reloadPending = deferred();
    second.mockReturnValue(reloadPending.promise);
    await act(async () => latest.reload());
    expect(latest).toMatchObject({ status: 'loading', data: null, error: null });
    await act(async () => reloadPending.resolve('reloaded'));
    expect(latest).toMatchObject({ status: 'ready', data: 'reloaded' });
  });

  it('accepts only the latest reload and ignores late failures', async () => {
    const first = deferred();
    const second = deferred();
    const third = deferred();
    const load = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(third.promise);
    await render('a', load);
    await act(async () => latest.reload());
    await act(async () => latest.reload());
    await act(async () => third.resolve('latest'));
    await act(async () => second.reject(new Error('stale')));
    await act(async () => first.resolve('old'));
    expect(latest).toMatchObject({ status: 'ready', data: 'latest', error: null });
  });

  it('ignores a pending result after unmount', async () => {
    const pending = deferred();
    await render('a', () => pending.promise);
    const beforeUnmount = latest;
    act(() => root.unmount());
    await act(async () => pending.resolve('late'));
    expect(latest).toBe(beforeUnmount);
    root = createRoot(container);
  });
});
