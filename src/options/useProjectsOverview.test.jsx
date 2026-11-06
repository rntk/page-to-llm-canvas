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
