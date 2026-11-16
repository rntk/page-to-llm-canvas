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
 * Wraps a mutable key -> element store in a read/write facade that hides the ref.
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
 * Owns the summary-card element registry; identity is stable, so it is a safe effect dependency.
 *
 * @returns {CardElementRegistry}
 */
export function useSummaryCardRegistry() {
  // A plain object, not a ref: a ref read during render would trip `react-hooks/refs`.
  // The lazy initializer runs once, keeping identity stable.
  const [registry] = useState(() => createCardElementRegistry({ current: {} }));
  return registry;
}
