// @vitest-environment happy-dom
import React, { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useProjectView } from './useProjectView.js';

let container;
let root;
let latest;

function Harness({ onValue, ...props }) {
  const value = useProjectView(props);
  useEffect(() => {
    onValue(value);
  });
  return null;
}

function makeScheduler() {
  return {
    setTimeout: (cb, ms) => globalThis.setTimeout(cb, ms),
    clearTimeout: (id) => globalThis.clearTimeout(id),
  };
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

const viewOf = (title) => ({ project: { id: 'a', title }, isOpen: true, tabs: [] });

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

function setup({ api, subscribe, projectId = 'a' }) {
  const scheduler = makeScheduler();
  return act(async () =>
    root.render(
      <Harness
        onValue={(value) => {
          latest = value;
        }}
        projectId={projectId}
        api={api}
        subscribe={subscribe}
        scheduler={scheduler}
      />,
    ),
  );
}

describe('useProjectView', () => {
  it('is idle without a project id and does not fetch', async () => {
    const api = { getProjectView: vi.fn() };
    await setup({ api, projectId: null });
    expect(latest.status).toBe('idle');
    expect(api.getProjectView).not.toHaveBeenCalled();
  });

  it('loads then exposes the view', async () => {
    const api = { getProjectView: vi.fn(async () => viewOf('One')) };
    await setup({ api });
    expect(api.getProjectView).toHaveBeenCalledWith('a');
    expect(latest.status).toBe('ready');
    expect(latest.view.project.title).toBe('One');
  });

  it('exposes the error message on failure', async () => {
    const api = {
      getProjectView: vi.fn(async () => Promise.reject(new Error('project not found'))),
    };
    await setup({ api });
    expect(latest).toMatchObject({ status: 'error', error: 'project not found', view: null });
  });

  it('debounces bursts of change events into one refetch', async () => {
    let notify;
    const subscribe = vi.fn((cb) => {
      notify = cb;
      return () => {};
    });
    const api = { getProjectView: vi.fn(async () => viewOf('One')) };
    await setup({ api, subscribe });
    expect(api.getProjectView).toHaveBeenCalledTimes(1);

    await act(async () => {
      notify();
      vi.advanceTimersByTime(100);
      notify();
      vi.advanceTimersByTime(100);
      notify();
    });
    expect(api.getProjectView).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(150);
    });
    expect(api.getProjectView).toHaveBeenCalledTimes(2);
  });

  it('ignores a stale response that resolves after a newer one', async () => {
    let notify;
    const subscribe = (cb) => {
      notify = cb;
      return () => {};
    };
    const first = deferred();
    const second = deferred();
    const api = {
      getProjectView: vi
        .fn()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise),
    };
    await setup({ api, subscribe });
    await act(async () => {
      notify();
      vi.advanceTimersByTime(150);
    });
    expect(api.getProjectView).toHaveBeenCalledTimes(2);

    await act(async () => second.resolve(viewOf('Newer')));
    expect(latest.view.project.title).toBe('Newer');
    await act(async () => first.resolve(viewOf('Stale')));
    expect(latest.view.project.title).toBe('Newer');
  });

  it('unsubscribes, drops pending refreshes and ignores late responses on unmount', async () => {
    let notify;
    const unsubscribe = vi.fn();
    const subscribe = (cb) => {
      notify = cb;
      return unsubscribe;
    };
    const pending = deferred();
    const api = {
      getProjectView: vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(viewOf('x')),
    };
    await setup({ api, subscribe });
    await act(async () => {
      notify();
    });
    act(() => root.unmount());
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(500);
      pending.resolve(viewOf('late'));
    });
    expect(api.getProjectView).toHaveBeenCalledTimes(1);
    // re-create root so afterEach unmount has something valid to unmount
    root = createRoot(container);
  });
});
