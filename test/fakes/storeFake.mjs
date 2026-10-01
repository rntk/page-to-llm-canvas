import { vi } from 'vitest';

/**
 * Fake injected store for driving component subscriptions directly.
 *
 * @returns {{
 *   subscribe: Function,
 *   publish: function(*): void,
 *   unsubscribe: Function,
 *   subscribedKeys: string[],
 *   listenerCount: number,
 * }}
 */
export function createFakeStore() {
  const listeners = [];
  const subscribedKeys = [];
  const unsubscribe = vi.fn((listener) => {
    const index = listeners.indexOf(listener);
    if (index !== -1) listeners.splice(index, 1);
  });

  return {
    subscribedKeys,
    unsubscribe,
    subscribe: vi.fn((key, listener) => {
      subscribedKeys.push(key);
      listeners.push(listener);
      return () => unsubscribe(listener);
    }),
    /**
     * Delivers a new stored value to every live subscriber.
     * @param {*} newValue Value as the adapter would report it.
     */
    publish(newValue) {
      listeners.slice().forEach((listener) => listener(newValue));
    },
    get listenerCount() {
      return listeners.length;
    },
  };
}
