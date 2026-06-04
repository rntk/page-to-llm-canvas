// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { useRecord } from './useRecord.js';

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
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe('useRecord', () => {
  let changeListeners = [];

  beforeEach(() => {
    changeListeners = [];
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage: vi.fn(),
        lastError: null,
      },
      storage: {
        local: {
          get: vi.fn(),
        },
        onChanged: {
          addListener: vi.fn((fn) => changeListeners.push(fn)),
          removeListener: vi.fn((fn) => {
            const idx = changeListeners.indexOf(fn);
            if (idx !== -1) changeListeners.splice(idx, 1);
          }),
        },
      },
    });
  });

  it('sets error when key is missing', () => {
    const { result } = renderHook(() => useRecord(''));
    expect(result.current.error).toBe('missing record key');
    expect(result.current.record).toBeNull();
  });

  it('fetches record via sendMessage on mount', () => {
    const record = { key: 'test', status: 'done' };
    chrome.runtime.sendMessage.mockImplementation((msg, cb) => {
      cb({ ok: true, record });
    });

    const { result } = renderHook(() => useRecord('test'));
    expect(result.current.record).toEqual(record);
    expect(result.current.error).toBeNull();
  });

  it('falls back to storage.local when sendMessage returns no record', () => {
    chrome.runtime.sendMessage.mockImplementation((msg, cb) => {
      cb({ ok: false });
    });
    const record = { key: 'test', status: 'done' };
    chrome.storage.local.get.mockImplementation((keys, cb) => {
      cb({ 'pagetollm:rec:test': record });
    });

    const { result } = renderHook(() => useRecord('test'));
    expect(result.current.record).toEqual(record);
    expect(result.current.error).toBeNull();
  });

  it('sets error when record is not found anywhere', () => {
    chrome.runtime.sendMessage.mockImplementation((msg, cb) => {
      cb({ ok: false });
    });
    chrome.storage.local.get.mockImplementation((keys, cb) => {
      cb({});
    });

    const { result } = renderHook(() => useRecord('test'));
    expect(result.current.error).toBe('record not found');
    expect(result.current.record).toBeNull();
  });

  it('handles runtime.lastError on sendMessage', () => {
    chrome.runtime.sendMessage.mockImplementation((msg, cb) => {
      chrome.runtime.lastError = { message: 'disconnected' };
      cb();
      chrome.runtime.lastError = null;
    });

    const { result } = renderHook(() => useRecord('test'));
    expect(result.current.error).toBe('disconnected');
  });

  it('updates record on storage change', () => {
    chrome.runtime.sendMessage.mockImplementation((msg, cb) => {
      cb({ ok: true, record: { key: 'test', status: 'pending' } });
    });

    const { result } = renderHook(() => useRecord('test'));
    expect(result.current.record.status).toBe('pending');

    act(() => {
      changeListeners.forEach((fn) =>
        fn({ 'pagetollm:rec:test': { newValue: { key: 'test', status: 'done' } } }, 'local'),
      );
    });

    expect(result.current.record.status).toBe('done');
    expect(result.current.error).toBeNull();
  });

  it('sets error when record is deleted from storage', () => {
    chrome.runtime.sendMessage.mockImplementation((msg, cb) => {
      cb({ ok: true, record: { key: 'test', status: 'pending' } });
    });

    const { result } = renderHook(() => useRecord('test'));

    act(() => {
      changeListeners.forEach((fn) =>
        fn(
          {
            'pagetollm:rec:test': {
              oldValue: { key: 'test' },
              newValue: undefined,
            },
          },
          'local',
        ),
      );
    });

    expect(result.current.record).toBeNull();
    expect(result.current.error).toBe('record deleted');
  });

  it('ignores storage changes for other keys', () => {
    chrome.runtime.sendMessage.mockImplementation((msg, cb) => {
      cb({ ok: true, record: { key: 'test', status: 'pending' } });
    });

    const { result } = renderHook(() => useRecord('test'));

    act(() => {
      changeListeners.forEach((fn) =>
        fn({ 'pagetollm:rec:other': { newValue: { key: 'other' } } }, 'local'),
      );
    });

    expect(result.current.record.status).toBe('pending');
  });

  it('ignores storage changes for non-local area', () => {
    chrome.runtime.sendMessage.mockImplementation((msg, cb) => {
      cb({ ok: true, record: { key: 'test', status: 'pending' } });
    });

    const { result } = renderHook(() => useRecord('test'));

    act(() => {
      changeListeners.forEach((fn) =>
        fn({ 'pagetollm:rec:test': { newValue: { key: 'test', status: 'done' } } }, 'sync'),
      );
    });

    expect(result.current.record.status).toBe('pending');
  });

  it('removes onChanged listener on unmount', () => {
    chrome.runtime.sendMessage.mockImplementation((msg, cb) => {
      cb({ ok: true, record: { key: 'test', status: 'pending' } });
    });

    const { unmount } = renderHook(() => useRecord('test'));
    expect(chrome.storage.onChanged.addListener).toHaveBeenCalled();
    unmount();
    expect(chrome.storage.onChanged.removeListener).toHaveBeenCalled();
  });

  it('resets record and fetches new record when key changes', () => {
    let currentKey = 'key1';
    const container = document.createElement('div');
    document.body.appendChild(container);
    let result = { current: null };
    function TestComponent() {
      result.current = useRecord(currentKey);
      return null;
    }
    const root = createRoot(container);

    chrome.runtime.sendMessage.mockImplementation((msg, cb) => {
      if (msg.key === 'key1') {
        cb({ ok: true, record: { key: 'key1', val: 'a' } });
      } else if (msg.key === 'key2') {
        cb({ ok: true, record: { key: 'key2', val: 'b' } });
      }
    });

    act(() => root.render(createElement(TestComponent)));
    expect(result.current.record).toEqual({ key: 'key1', val: 'a' });

    // Change key and re-render
    currentKey = 'key2';
    act(() => root.render(createElement(TestComponent)));

    expect(result.current.record).toEqual({ key: 'key2', val: 'b' });

    act(() => root.unmount());
    container.remove();
  });
});
