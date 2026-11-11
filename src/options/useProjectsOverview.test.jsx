// @vitest-environment happy-dom
import React, { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useProjectsOverview } from './useProjectsOverview.js';

const probe = { current: null };
let root;
let container;

function Probe({ onValue, ...options }) {
  const value = useProjectsOverview(options);
  useEffect(() => {
    onValue(value);
  });
  return null;
}

function overviewOf(title) {
  return { projects: [{ id: title }], ungroupedGroups: [] };
}

function mount(props) {
  return act(async () => {
    root.render(
      <Probe
        {...props}
        onValue={(value) => {
          probe.current = value;
        }}
      />,
    );
  });
}

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

describe('useProjectsOverview', () => {
  it('loads the overview on mount', async () => {
    const listOverview = vi.fn().mockResolvedValue(overviewOf('a'));
    await mount({ listOverview, subscribe: vi.fn(() => vi.fn()) });

    expect(probe.current.isLoading).toBe(false);
    expect(probe.current.loadError).toBe('');
    expect(probe.current.overview.projects).toEqual([{ id: 'a' }]);
  });

  it('captures capabilities at mount and reuses them when debounce changes', async () => {
    const firstList = vi.fn().mockResolvedValue(overviewOf('first'));
    const nextList = vi.fn().mockResolvedValue(overviewOf('next'));
    const unsubscribe = vi.fn();
    const firstSubscribe = vi.fn(() => unsubscribe);
    const nextSubscribe = vi.fn(() => vi.fn());
    await mount({ listOverview: firstList, subscribe: firstSubscribe, debounceMs: 200 });
    await mount({ listOverview: nextList, subscribe: nextSubscribe, debounceMs: 200 });
    expect(firstList).toHaveBeenCalledTimes(1);
    expect(firstSubscribe).toHaveBeenCalledTimes(1);
    await mount({ listOverview: nextList, subscribe: nextSubscribe, debounceMs: 50 });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(firstList).toHaveBeenCalledTimes(2);
    expect(firstSubscribe).toHaveBeenCalledTimes(2);
    expect(nextList).not.toHaveBeenCalled();
    expect(nextSubscribe).not.toHaveBeenCalled();
  });

  it('exposes loading, errors and recovery while reload waits for completion', async () => {
    let resolveInitial;
    let resolveRecovery;
    const listOverview = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveInitial = resolve;
          }),
      )
      .mockRejectedValueOnce({})
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRecovery = resolve;
          }),
      );
    await mount({ listOverview, subscribe: vi.fn(() => vi.fn()) });
    expect(probe.current.isLoading).toBe(true);
    await act(async () => resolveInitial(overviewOf('saved')));
    await act(async () => {
      await probe.current.reload();
    });
    expect(probe.current).toMatchObject({
      isLoading: false,
      loadError: 'Failed to load projects',
      overview: overviewOf('saved'),
    });
    let finished = false;
    let reload;
    act(() => {
      reload = probe.current.reload().then(() => {
        finished = true;
      });
    });
    expect(finished).toBe(false);
    expect(probe.current.isLoading).toBe(false);
    await act(async () => {
      resolveRecovery(overviewOf('recovered'));
      await reload;
    });
    expect(finished).toBe(true);
    expect(probe.current).toMatchObject({
      isLoading: false,
      loadError: '',
      overview: overviewOf('recovered'),
    });
  });

  it('recovers from an initial failure and ignores a stale rejection', async () => {
    let rejectStale;
    const listOverview = vi
      .fn()
      .mockRejectedValueOnce(new Error('initial failure'))
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectStale = reject;
          }),
      )
      .mockResolvedValueOnce(overviewOf('current'));
    await mount({ listOverview, subscribe: vi.fn(() => vi.fn()) });
    expect(probe.current).toMatchObject({ isLoading: false, loadError: 'initial failure' });
    let stale;
    act(() => {
      stale = probe.current.reload();
    });
    await act(async () => {
      await probe.current.reload();
    });
    await act(async () => {
      rejectStale(new Error('stale'));
      await stale;
    });
    expect(probe.current).toMatchObject({ loadError: '', overview: overviewOf('current') });
  });

  it('ignores an in-flight result after unmount', async () => {
    let resolve;
    const listOverview = vi.fn(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const onValue = vi.fn();
    await act(async () =>
      root.render(
        <Probe listOverview={listOverview} subscribe={() => () => {}} onValue={onValue} />,
      ),
    );
    act(() => root.unmount());
    const calls = onValue.mock.calls.length;
    await act(async () => resolve(overviewOf('late')));
    expect(onValue).toHaveBeenCalledTimes(calls);
    root = createRoot(container);
  });

  it('debounces bursts of change events into one refetch', async () => {
    const listOverview = vi.fn().mockResolvedValue(overviewOf('a'));
    let notify;
    const subscribe = vi.fn((onChange) => {
      notify = onChange;
      return vi.fn();
    });
    await mount({ listOverview, subscribe });
    expect(listOverview).toHaveBeenCalledTimes(1);

    notify();
    notify();
    notify();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(199);
    });
    expect(listOverview).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(listOverview).toHaveBeenCalledTimes(2);
  });

  it('lets only the latest request win', async () => {
    const resolvers = [];
    const listOverview = vi.fn(() => new Promise((resolve) => resolvers.push(resolve)));
    await mount({ listOverview, subscribe: vi.fn(() => vi.fn()) });

    let second;
    act(() => {
      second = probe.current.reload();
    });
    await act(async () => {
      resolvers[1](overviewOf('new'));
      await second;
    });
    await act(async () => {
      resolvers[0](overviewOf('old'));
    });

    expect(probe.current.overview.projects).toEqual([{ id: 'new' }]);
  });

  it('keeps the last overview and reports the error when a refresh fails', async () => {
    const listOverview = vi
      .fn()
      .mockResolvedValueOnce(overviewOf('a'))
      .mockRejectedValueOnce(new Error('worker offline'));
    await mount({ listOverview, subscribe: vi.fn(() => vi.fn()) });

    await act(async () => {
      await probe.current.reload();
    });

    expect(probe.current.loadError).toBe('worker offline');
    expect(probe.current.overview.projects).toEqual([{ id: 'a' }]);
    expect(probe.current.isLoading).toBe(false);
  });

  it('unsubscribes and cancels pending refreshes on unmount', async () => {
    const listOverview = vi.fn().mockResolvedValue(overviewOf('a'));
    const unsubscribe = vi.fn();
    let notify;
    const subscribe = vi.fn((onChange) => {
      notify = onChange;
      return unsubscribe;
    });
    await mount({ listOverview, subscribe });

    notify();
    await act(async () => root.unmount());
    await vi.advanceTimersByTimeAsync(500);

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(listOverview).toHaveBeenCalledTimes(1);
    root = createRoot(container);
  });
});
