import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserLocalStore, subscribeLocalChanges, subscribeLocalKey } from './localStore.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('localStore subscriptions', () => {
  it('filters one event to watched keys and unsubscribes the exact listener', () => {
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
    const onChanges = vi.fn();
    const unsubscribe = subscribeLocalChanges(['theme', 'color'], onChanges);

    listener({ other: { newValue: 1 } }, 'local');
    listener({ theme: { newValue: 'dark' } }, 'sync');
    listener(null, 'local');
    listener(
      { theme: { newValue: 'dark' }, color: { newValue: '#fff' }, other: { newValue: 1 } },
      'local',
    );

    expect(onChanges).toHaveBeenCalledOnce();
    expect(onChanges).toHaveBeenCalledWith({
      theme: { newValue: 'dark' },
      color: { newValue: '#fff' },
    });
    unsubscribe();
    expect(removeListener).toHaveBeenCalledWith(listener);
  });

  it('adapts a single-key change to its new value and no-ops without Chrome', () => {
    let listener;
    vi.stubGlobal('chrome', {
      storage: {
        onChanged: {
          addListener: (nextListener) => {
            listener = nextListener;
          },
          removeListener: vi.fn(),
        },
      },
    });
    const onValue = vi.fn();
    subscribeLocalKey('theme', onValue);
    listener({ theme: { oldValue: 'light', newValue: 'dark' } }, 'local');
    expect(onValue).toHaveBeenCalledWith('dark');
    expect(browserLocalStore.subscribe).toBe(subscribeLocalKey);

    vi.stubGlobal('chrome', undefined);
    expect(() => subscribeLocalChanges(['theme'], vi.fn())()).not.toThrow();
  });
});
