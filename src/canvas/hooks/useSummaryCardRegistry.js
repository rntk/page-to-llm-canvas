import { useState } from 'react';

/**
 * @typedef {object} CardElementRegistry
 * @property {function(?string): ?Element} get Element registered under `key`, or null.
 * @property {function(): Array<[string, Element]>} entries Registered [key, element] pairs.
 * @property {function(string, ?Element): void} register Registers `element`, or
 *   unregisters `key` when `element` is nullish (React calls ref callbacks with
 *   null on unmount).
 */

/**
 * Wraps a mutable key -> element store in a stable read/write facade so consumers
 * never receive the underlying ref object itself.
 *
 * @param {{current: Object<string, Element>}} store
 * @returns {CardElementRegistry}
 */
export function createCardElementRegistry(store) {
  return {
    get: (key) => store.current[key] || null,
    entries: () => Object.entries(store.current),
    register: (key, element) => {
      if (element) store.current[key] = element;
      else delete store.current[key];
    },
  };
}

/**
 * Owns the summary-card DOM element registry. The identity is stable for the
 * lifetime of the component, so consumers can list it as an effect dependency.
 *
 * @returns {CardElementRegistry}
 */
export function useSummaryCardRegistry() {
  // The store is a plain object rather than a ref: nothing here participates in
  // React's render cycle, and a ref would trip `react-hooks/refs` by being read
  // during render. The lazy initializer runs once, so the identity is stable.
  const [registry] = useState(() => createCardElementRegistry({ current: {} }));
  return registry;
}
