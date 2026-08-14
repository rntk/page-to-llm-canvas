import { vi } from 'vitest';

/**
 * A fake of the injected store capability (`browserLocalStore`) for component
 * tests.
 *
 * Components and hooks take `store` so their subscription can be driven
 * directly instead of through a `chrome.storage.onChanged` stub. The
 * chrome-backed adapter that sits here in production has its own coverage in
 * `src/shared/runtime/localStore.test.js` — area filtering, watched-key
 * filtering, listener add/remove, and tolerating a missing storage API — so
 * component tests can assert component behavior only.
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
