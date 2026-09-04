// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { RECORD_REFRESH_DEBOUNCE_MS, useRecord } from './useRecord.js';

// The hook is exercised against a fake record source rather than the
// chrome-backed one. The browser adapters it would otherwise reach through have
// their own tests: runtimeMessages.test.js covers lastError rejection, and
// localStore.test.js covers the `local` area filter, the watched-key filter and
// the addListener/removeListener plumbing. Repeating those here would assert
// the adapter twice and leave the hook's own contract — which fetch happens
// when, and what lands in state — untested.
function createFakeSource() {
  let subscription = null;
  const unsubscribe = vi.fn(() => {
    subscription = null;
  });
  return {
    fetch: vi.fn(),
    subscribe: vi.fn((key, onChange) => {
      subscription = { key, onChange };
      return unsubscribe;
    }),
    unsubscribe,
    get subscribedKey() {
      return subscription ? subscription.key : null;
    },
    /** Simulates one storage event for the watched docs. */
    notifyChange() {
      subscription.onChange({});
    },
  };
}

function renderHook(callback) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let result = { current: null };
  function TestComponent() {
    result.current = callback();
    return null;
  }
  const root = createRoot(container);
  act(() => root.render(createElement(TestComponent)));
  return {
    result,
    rerender() {
      act(() => root.render(createElement(TestComponent)));
    },
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

// Every fetch (initial load and live-update refetch) resolves through a promise.
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useRecord', () => {
  let source;

  beforeEach(() => {
    source = createFakeSource();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sets error when key is missing', () => {
    const { result } = renderHook(() => useRecord('', source));
    expect(result.current.error).toBe('missing record key');
    expect(result.current.record).toBeNull();
    expect(source.subscribe).not.toHaveBeenCalled();
  });

  it('reports an unusable source instead of throwing out of the effect', () => {
    const { result } = renderHook(() => useRecord('test', undefined));
    expect(result.current.error).toBe('record source unavailable');
    expect(result.current.record).toBeNull();
    expect(result.current.isDeleted).toBe(false);
  });

  it('fetches the record through the messenger and watches its view documents', async () => {
    const record = { key: 'test', status: 'done' };
    source.fetch.mockResolvedValue({ ok: true, record });

    const { result } = renderHook(() => useRecord('test', source));
    await flush();

    expect(source.fetch).toHaveBeenCalledWith('test');
    expect(source.subscribedKey).toBe('test');
    expect(result.current.record).toEqual(record);
    expect(result.current.error).toBeNull();
  });

  it('surfaces an initial record-service error without treating it as deletion', async () => {
    source.fetch.mockResolvedValue({
      ok: false,
      error: 'storage temporarily unavailable',
    });

    const { result } = renderHook(() => useRecord('test', source));
    await flush();

    expect(result.current.error).toBe('storage temporarily unavailable');
    expect(result.current.record).toBeNull();
    expect(result.current.isDeleted).toBe(false);
  });

  it('surfaces a pipeline runtime failure without using the raw in-flight record', async () => {
    source.fetch.mockResolvedValue({
      ok: true,
      record: { key: 'test', status: 'summarizing' },
      pipelineFailure: { message: 'Storage unavailable. Retry processing.' },
    });

    const { result } = renderHook(() => useRecord('test', source));
    await flush();

    expect(result.current.error).toBe('Storage unavailable. Retry processing.');
    expect(result.current.record).toBeNull();
  });

  it('sets deletion state when the worker reports the record is absent', async () => {
    source.fetch.mockResolvedValue({ ok: false, code: 'not_found', error: 'record not found' });

    const { result } = renderHook(() => useRecord('test', source));
    await flush();

    expect(result.current.error).toBe('record not found');
    expect(result.current.record).toBeNull();
    expect(result.current.isDeleted).toBe(true);
  });

  it('debounces watched-doc changes before refetching the whole record', async () => {
    vi.useFakeTimers();
    source.fetch.mockResolvedValue({
      ok: true,
      record: { key: 'test', status: 'pending' },
    });

    const { result } = renderHook(() => useRecord('test', source));
    await flush();
    expect(result.current.record.status).toBe('pending');

    // A live update re-fetches through the same messenger path rather than
    // trusting the change payload directly (the payload is only one of the
    // three physical docs, not the full record).
    source.fetch.mockResolvedValue({
      ok: true,
      record: { key: 'test', status: 'done' },
    });
    act(() => source.notifyChange());
    act(() => source.notifyChange());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RECORD_REFRESH_DEBOUNCE_MS - 1);
    });
    expect(source.fetch).toHaveBeenCalledOnce();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    await flush();

    expect(source.fetch).toHaveBeenCalledTimes(2);
    expect(result.current.record.status).toBe('done');
    expect(result.current.error).toBeNull();
  });

  it('sets error when a refetch finds the record gone', async () => {
    vi.useFakeTimers();
    source.fetch.mockResolvedValue({
      ok: true,
      record: { key: 'test', status: 'pending' },
    });

    const { result } = renderHook(() => useRecord('test', source));
    await flush();

    source.fetch.mockResolvedValue({ ok: false, code: 'not_found', error: 'record not found' });
    act(() => source.notifyChange());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RECORD_REFRESH_DEBOUNCE_MS);
    });
    await flush();

    expect(result.current.record).toBeNull();
    expect(result.current.error).toBe('record deleted');
    expect(result.current.isDeleted).toBe(true);
  });

  it('keeps the current record open when a refresh returns a service error', async () => {
    vi.useFakeTimers();
    const record = { key: 'test', status: 'done' };
    source.fetch.mockResolvedValue({ ok: true, record });

    const { result } = renderHook(() => useRecord('test', source));
    await flush();
    source.fetch.mockResolvedValue({
      ok: false,
      error: 'storage temporarily unavailable',
    });
    act(() => source.notifyChange());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RECORD_REFRESH_DEBOUNCE_MS);
    });
    await flush();

    expect(result.current.record).toEqual(record);
    expect(result.current.error).toBe('storage temporarily unavailable');
    expect(result.current.isDeleted).toBe(false);
  });

  it('surfaces a rejected send as the error message', async () => {
    source.fetch.mockRejectedValue(new Error('disconnected'));

    const { result } = renderHook(() => useRecord('test', source));
    await flush();

    expect(result.current.error).toBe('disconnected');
    expect(result.current.record).toBeNull();
  });

  it('unsubscribes on unmount', async () => {
    source.fetch.mockResolvedValue({
      ok: true,
      record: { key: 'test', status: 'pending' },
    });

    const { unmount } = renderHook(() => useRecord('test', source));
    expect(source.subscribe).toHaveBeenCalledOnce();
    unmount();
    expect(source.unsubscribe).toHaveBeenCalledOnce();
  });

  it('cancels a pending refresh on unmount', async () => {
    vi.useFakeTimers();
    source.fetch.mockResolvedValue({
      ok: true,
      record: { key: 'test', status: 'done' },
    });

    const { unmount } = renderHook(() => useRecord('test', source));
    await flush();
    act(() => source.notifyChange());
    unmount();
    await vi.advanceTimersByTimeAsync(RECORD_REFRESH_DEBOUNCE_MS);

    expect(source.fetch).toHaveBeenCalledOnce();
  });

  it('ignores an initial response invalidated by a newer storage revision', async () => {
    vi.useFakeTimers();
    let resolveInitial;
    let resolveRefresh;
    source.fetch
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveInitial = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRefresh = resolve;
          }),
      );

    const { result, unmount } = renderHook(() => useRecord('test', source));
    act(() => source.notifyChange());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RECORD_REFRESH_DEBOUNCE_MS);
    });

    resolveRefresh({ ok: true, record: { key: 'test', version: 'new' } });
    await flush();
    resolveInitial({ ok: true, record: { key: 'test', version: 'old' } });
    await flush();

    expect(result.current.record).toEqual({ key: 'test', version: 'new' });
    unmount();
  });

  it('resets record and resubscribes when the key changes', async () => {
    let currentKey = 'key1';
    source.fetch.mockImplementation((key) =>
      Promise.resolve({ ok: true, record: { key, val: key === 'key1' ? 'a' : 'b' } }),
    );

    const { result, rerender, unmount } = renderHook(() => useRecord(currentKey, source));
    await flush();
    expect(result.current.record).toEqual({ key: 'key1', val: 'a' });

    currentKey = 'key2';
    rerender();
    await flush();

    expect(result.current.record).toEqual({ key: 'key2', val: 'b' });
    expect(source.unsubscribe).toHaveBeenCalledOnce();
    expect(source.subscribedKey).toBe('key2');

    unmount();
  });

  it('does not resubscribe when a caller rebuilds the source wrapper per render', async () => {
    source.fetch.mockResolvedValue({ ok: true, record: { key: 'test' } });

    const { rerender, unmount } = renderHook(() =>
      // A fresh object identity each render, same capability members.
      useRecord('test', { fetch: source.fetch, subscribe: source.subscribe }),
    );
    await flush();
    rerender();
    rerender();
    await flush();

    expect(source.subscribe).toHaveBeenCalledOnce();
    unmount();
  });
});
