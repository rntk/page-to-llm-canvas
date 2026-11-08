/**
 * Wraps an async function so its promise is created once and shared by every
 * later call. A rejection clears the cache, so the next call tries again (e.g.
 * after a tab finishes loading).
 *
 * @template T
 * @param {function(): Promise<T>} fn
 * @returns {function(): Promise<T>}
 */
export function onceWithRetry(fn) {
  let pending = null;
  return () => {
    pending ??= fn().catch((err) => {
      pending = null;
      throw err;
    });
    return pending;
  };
}
