import { afterEach, describe, expect, it, vi } from 'vitest';
import { isRecordStorageChange, subscribeRecordChanges } from './recordChanges.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isRecordStorageChange', () => {
  it('watches the record index and per-record keys in the local area', () => {
    expect(isRecordStorageChange({ 'pagetollm:index': { newValue: {} } }, 'local')).toBe(true);
    expect(isRecordStorageChange({ 'pagetollm:rec:rec1:meta': { newValue: {} } }, 'local')).toBe(
      true,
    );
  });

  it('ignores unrelated keys, other areas, and empty events', () => {
    expect(isRecordStorageChange({ unrelated: { newValue: 1 } }, 'local')).toBe(false);
    expect(isRecordStorageChange({ 'pagetollm:rec:rec1:meta': { newValue: {} } }, 'sync')).toBe(
      false,
    );
    expect(isRecordStorageChange({ 'pagetollm:other': { newValue: {} } }, 'session')).toBe(false);
    expect(isRecordStorageChange(null, 'local')).toBe(false);
  });

  it('watches the pipeline-failure breaker in the session area', () => {
    expect(
      isRecordStorageChange(
        { 'pagetollm:pipeline-failure-breakers': { newValue: {} } },
        'session',
      ),
    ).toBe(true);
  });
});

describe('subscribeRecordChanges', () => {
  it('forwards only record-relevant events and unsubscribes the exact listener', () => {
    let listener;
    const removeListener = vi.fn();
    vi.stubGlobal('chrome', {
      storage: {
        onChanged: {
          addListener: vi.fn((nextListener) => {
            listener = nextListener;
          }),
          removeListener,
        },
      },
    });

    const onChange = vi.fn();
    const unsubscribe = subscribeRecordChanges(onChange);

    listener({ unrelated: { newValue: 1 } }, 'local');
    expect(onChange).not.toHaveBeenCalled();
    listener({ 'pagetollm:rec:rec1:log': { newValue: {} } }, 'local');
    expect(onChange).toHaveBeenCalledOnce();

    unsubscribe();
    expect(removeListener).toHaveBeenCalledWith(listener);
  });

  it('no-ops without a chrome storage subscription capability', () => {
    vi.stubGlobal('chrome', { storage: {} });
    const onChange = vi.fn();
    expect(() => subscribeRecordChanges(onChange)()).not.toThrow();
    expect(onChange).not.toHaveBeenCalled();

    vi.stubGlobal('chrome', undefined);
    expect(() => subscribeRecordChanges(onChange)()).not.toThrow();
  });
});
