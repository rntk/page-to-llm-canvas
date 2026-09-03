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
    runtimeMessenger: { send: vi.fn() },
    store: {
      get: vi.fn(),
      subscribeChanges: vi.fn((keys, onChange) => {
        subscription = { keys, onChange };
        return unsubscribe;
      }),
    },
    unsubscribe,
    get watchedKeys() {
      return subscription ? subscription.keys : null;
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

// Every fetch (initial load and live-update refetch) resolves through at least
// one promise, and the storage fallback adds a second. Flush both ticks before
// asserting.
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const DOC_KEYS = [
  'pagetollm:rec:test:meta',
  'pagetollm:rec:test:content',
  'pagetollm:rec:test:summaries',
];

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
    expect(source.store.subscribeChanges).not.toHaveBeenCalled();
  });

  it('fetches the record through the messenger and watches its three docs', async () => {
    const record = { key: 'test', status: 'done' };
    source.runtimeMessenger.send.mockResolvedValue({ ok: true, record });

    const { result } = renderHook(() => useRecord('test', source));
    await flush();

    expect(source.runtimeMessenger.send).toHaveBeenCalledWith({ type: 'getRecord', key: 'test' });
    expect(source.watchedKeys).toEqual(DOC_KEYS);
    expect(result.current.record).toEqual(record);
    expect(result.current.error).toBeNull();
    expect(source.store.get).not.toHaveBeenCalled();
  });

  it('falls back to a direct store read when the messenger returns no record', async () => {
    const record = { key: 'test', status: 'done' };
    source.runtimeMessenger.send.mockResolvedValue({ ok: false });
    source.store.get.mockResolvedValue({ 'pagetollm:rec:test:meta': record });

    const { result } = renderHook(() => useRecord('test', source));
    await flush();

    expect(source.store.get).toHaveBeenCalledWith(DOC_KEYS);
    expect(result.current.record).toEqual(record);
    expect(result.current.error).toBeNull();
  });

  it('falls back to a direct store read on the uniform record-not-found error', async () => {
    const record = { key: 'test', status: 'done' };
    source.runtimeMessenger.send.mockResolvedValue({ ok: false, error: 'record not found' });
    source.store.get.mockResolvedValue({ 'pagetollm:rec:test:meta': record });

    const { result } = renderHook(() => useRecord('test', source));
    await flush();

    expect(source.store.get).toHaveBeenCalledWith(DOC_KEYS);
    expect(result.current.record).toEqual(record);
    expect(result.current.error).toBeNull();
  });

  it('surfaces an initial record-service error without treating it as deletion', async () => {
    source.runtimeMessenger.send.mockResolvedValue({
      ok: false,
      error: 'storage temporarily unavailable',
    });

    const { result } = renderHook(() => useRecord('test', source));
    await flush();

    expect(result.current.error).toBe('storage temporarily unavailable');
    expect(result.current.record).toBeNull();
    expect(result.current.isDeleted).toBe(false);
    expect(source.store.get).not.toHaveBeenCalled();
  });

  it('surfaces a pipeline runtime failure without using the raw in-flight record', async () => {
    source.runtimeMessenger.send.mockResolvedValue({
      ok: true,
      record: { key: 'test', status: 'summarizing' },
      pipelineFailure: { message: 'Storage unavailable. Retry processing.' },
    });

    const { result } = renderHook(() => useRecord('test', source));
    await flush();

    expect(result.current.error).toBe('Storage unavailable. Retry processing.');
    expect(result.current.record).toBeNull();
    expect(source.store.get).not.toHaveBeenCalled();
  });

  it('reassembles a fallback record split across meta/content/summaries docs', async () => {
    source.runtimeMessenger.send.mockResolvedValue({ ok: false });
    source.store.get.mockResolvedValue({
      'pagetollm:rec:test:meta': { key: 'test', status: 'done' },
      'pagetollm:rec:test:content': { html: '<p>hi</p>' },
    });

    const { result } = renderHook(() => useRecord('test', source));
    await flush();

    expect(result.current.record).toEqual({ key: 'test', status: 'done', html: '<p>hi</p>' });
    expect(result.current.error).toBeNull();
  });

  it('sets error when the record is not found anywhere', async () => {
    source.runtimeMessenger.send.mockResolvedValue({ ok: false });
    source.store.get.mockResolvedValue({});

    const { result } = renderHook(() => useRecord('test', source));
    await flush();

    expect(result.current.error).toBe('record not found');
    expect(result.current.record).toBeNull();
    expect(result.current.isDeleted).toBe(true);
  });

  it('debounces watched-doc changes before refetching the whole record', async () => {
    vi.useFakeTimers();
    source.runtimeMessenger.send.mockResolvedValue({
      ok: true,
      record: { key: 'test', status: 'pending' },
    });

    const { result } = renderHook(() => useRecord('test', source));
    await flush();
    expect(result.current.record.status).toBe('pending');

    // A live update re-fetches through the same messenger path rather than
    // trusting the change payload directly (the payload is only one of the
    // three physical docs, not the full record).
    source.runtimeMessenger.send.mockResolvedValue({
      ok: true,
      record: { key: 'test', status: 'done' },
    });
    act(() => source.notifyChange());
    act(() => source.notifyChange());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RECORD_REFRESH_DEBOUNCE_MS - 1);
    });
    expect(source.runtimeMessenger.send).toHaveBeenCalledOnce();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    await flush();

    expect(source.runtimeMessenger.send).toHaveBeenCalledTimes(2);
    expect(result.current.record.status).toBe('done');
    expect(result.current.error).toBeNull();
  });

  it('sets error when a refetch finds the record gone', async () => {
    vi.useFakeTimers();
    source.runtimeMessenger.send.mockResolvedValue({
      ok: true,
      record: { key: 'test', status: 'pending' },
    });

    const { result } = renderHook(() => useRecord('test', source));
    await flush();

    source.runtimeMessenger.send.mockResolvedValue({ ok: false });
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
    source.runtimeMessenger.send.mockResolvedValue({ ok: true, record });

    const { result } = renderHook(() => useRecord('test', source));
    await flush();
    source.runtimeMessenger.send.mockResolvedValue({
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
    source.runtimeMessenger.send.mockRejectedValue(new Error('disconnected'));

    const { result } = renderHook(() => useRecord('test', source));
    await flush();

    expect(result.current.error).toBe('disconnected');
    expect(result.current.record).toBeNull();
  });

  it('surfaces a rejected fallback store read as the error message', async () => {
    source.runtimeMessenger.send.mockResolvedValue({ ok: false });
    source.store.get.mockRejectedValue(new Error('storage unavailable'));

    const { result } = renderHook(() => useRecord('test', source));
    await flush();

    expect(result.current.error).toBe('storage unavailable');
  });

  it('unsubscribes on unmount', async () => {
    source.runtimeMessenger.send.mockResolvedValue({
      ok: true,
      record: { key: 'test', status: 'pending' },
    });

    const { unmount } = renderHook(() => useRecord('test', source));
    expect(source.store.subscribeChanges).toHaveBeenCalledOnce();
    unmount();
    expect(source.unsubscribe).toHaveBeenCalledOnce();
  });

  it('cancels a pending refresh on unmount', async () => {
    vi.useFakeTimers();
    source.runtimeMessenger.send.mockResolvedValue({
      ok: true,
      record: { key: 'test', status: 'done' },
    });

    const { unmount } = renderHook(() => useRecord('test', source));
    await flush();
    act(() => source.notifyChange());
    unmount();
    await vi.advanceTimersByTimeAsync(RECORD_REFRESH_DEBOUNCE_MS);

    expect(source.runtimeMessenger.send).toHaveBeenCalledOnce();
  });

  it('ignores an initial response invalidated by a newer storage revision', async () => {
    vi.useFakeTimers();
    let resolveInitial;
    let resolveRefresh;
    source.runtimeMessenger.send
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
    source.runtimeMessenger.send.mockImplementation((msg) =>
      Promise.resolve({ ok: true, record: { key: msg.key, val: msg.key === 'key1' ? 'a' : 'b' } }),
    );

    const { result, rerender, unmount } = renderHook(() => useRecord(currentKey, source));
    await flush();
    expect(result.current.record).toEqual({ key: 'key1', val: 'a' });

    currentKey = 'key2';
    rerender();
    await flush();

    expect(result.current.record).toEqual({ key: 'key2', val: 'b' });
    expect(source.unsubscribe).toHaveBeenCalledOnce();
    expect(source.watchedKeys).toEqual([
      'pagetollm:rec:key2:meta',
      'pagetollm:rec:key2:content',
      'pagetollm:rec:key2:summaries',
    ]);

    unmount();
  });

  it('does not resubscribe when a caller rebuilds the source wrapper per render', async () => {
    source.runtimeMessenger.send.mockResolvedValue({ ok: true, record: { key: 'test' } });

    const { rerender, unmount } = renderHook(() =>
      // A fresh object identity each render, same capability members.
      useRecord('test', { runtimeMessenger: source.runtimeMessenger, store: source.store }),
    );
    await flush();
    rerender();
    rerender();
    await flush();

    expect(source.store.subscribeChanges).toHaveBeenCalledOnce();
    unmount();
  });
});
