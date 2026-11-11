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

  it('cleans up the old subscription and timer when dependencies change', async () => {
    let oldNotify;
    let newNotify;
    const unsubscribe = vi.fn();
    const oldSubscribe = vi.fn((notify) => {
      oldNotify = notify;
      return unsubscribe;
    });
    const newSubscribe = vi.fn((notify) => {
      newNotify = notify;
      return vi.fn();
    });
    const oldApi = { getProjectView: vi.fn().mockResolvedValue(viewOf('Old')) };
    const newApi = { getProjectView: vi.fn().mockResolvedValue(viewOf('New')) };
    await setup({ api: oldApi, subscribe: oldSubscribe });
    act(() => oldNotify());
    await setup({ api: newApi, subscribe: newSubscribe, projectId: 'b' });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(newApi.getProjectView).toHaveBeenCalledWith('b');
    await act(async () => {
      oldNotify();
      vi.advanceTimersByTime(500);
    });
    expect(oldApi.getProjectView).toHaveBeenCalledTimes(1);
    expect(newApi.getProjectView).toHaveBeenCalledTimes(1);
    await act(async () => {
      newNotify();
      vi.advanceTimersByTime(150);
    });
    expect(newApi.getProjectView).toHaveBeenCalledTimes(2);
  });

  it('cleans up pending work and ignores old notifications when disabled', async () => {
    let notify;
    const unsubscribe = vi.fn();
    const subscribe = (callback) => {
      notify = callback;
      return unsubscribe;
    };
    const api = { getProjectView: vi.fn().mockResolvedValue(viewOf('One')) };
    await setup({ api, subscribe });
    act(() => notify());
    await setup({ api, subscribe, projectId: null });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    await act(async () => {
      notify();
      vi.advanceTimersByTime(500);
    });
    expect(api.getProjectView).toHaveBeenCalledTimes(1);
    expect(latest.status).toBe('idle');
  });

  it('keeps unchanged topic merge parts identical across refetches', async () => {
    let notify;
    const subscribe = (cb) => {
      notify = cb;
      return () => {};
    };
    let nodes = { root: { id: 'root', children: [] } };
    const api = {
      getProjectView: vi.fn(async () => ({
        ...viewOf('One'),
        topicMerge: structuredClone({
          status: 'running',
          tree: { runId: 'r', nodes },
          eligiblePages: [{ url: 'u' }],
        }),
      })),
    };
    await setup({ api, subscribe });
    const first = latest.view.topicMerge;

    await act(async () => {
      notify();
      vi.advanceTimersByTime(150);
    });
    expect(api.getProjectView).toHaveBeenCalledTimes(2);
    expect(latest.view.topicMerge).toBe(first);

    // Same run, new progress: the tree changes, untouched siblings stay shared.
    nodes = { ...nodes, child: { id: 'child', children: [] } };
    await act(async () => {
      notify();
      vi.advanceTimersByTime(150);
    });
    expect(latest.view.topicMerge).not.toBe(first);
    expect(latest.view.topicMerge.tree).not.toBe(first.tree);
    expect(latest.view.topicMerge.tree.nodes.child).toEqual({ id: 'child', children: [] });
    expect(latest.view.topicMerge.tree.nodes.root).toBe(first.tree.nodes.root);
    expect(latest.view.topicMerge.eligiblePages).toBe(first.eligiblePages);
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

  it('retains the last view when a background refresh fails', async () => {
    const pending = deferred();
    const api = {
      getProjectView: vi
        .fn()
        .mockResolvedValueOnce(viewOf('Saved'))
        .mockReturnValueOnce(pending.promise),
    };
    await setup({ api });
    const saved = latest.view;
    await act(async () => latest.refresh());
    expect(latest).toMatchObject({ status: 'ready', view: saved, error: null });
    await act(async () => pending.reject(new Error('offline')));
    expect(latest).toMatchObject({ status: 'ready', view: saved, error: null });
  });

  it.each(['success', 'failure'])(
    'ignores a late %s after project and loader change',
    async (outcome) => {
      const pending = deferred();
      const oldApi = { getProjectView: vi.fn().mockReturnValue(pending.promise) };
      const newApi = { getProjectView: vi.fn().mockResolvedValue(viewOf('Current')) };
      await setup({ api: oldApi });
      await setup({ api: newApi, projectId: 'b' });
      expect(newApi.getProjectView).toHaveBeenCalledWith('b');
      await act(async () => {
        if (outcome === 'success') pending.resolve(viewOf('Old'));
        else pending.reject(new Error('old failure'));
      });
      expect(latest).toMatchObject({ status: 'ready', view: viewOf('Current'), error: null });
    },
  );

  it('provides a subscription getter that observes the latest view', async () => {
    let getView;
    const subscribe = (_notify, { scope }) => {
      getView = scope.getView;
      return () => {};
    };
    const api = {
      getProjectView: vi
        .fn()
        .mockResolvedValueOnce(viewOf('First'))
        .mockResolvedValueOnce(viewOf('Second')),
    };
    await setup({ api, subscribe });
    expect(getView()).toBe(latest.view);
    await act(async () => latest.refresh());
    expect(getView()).toBe(latest.view);
    expect(getView().project.title).toBe('Second');
  });
});
