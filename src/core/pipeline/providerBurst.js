import { parallelMap as defaultParallelMap } from '../llm/concurrency.js';
import { isPermanentProviderError } from './providerFailure.js';

/**
 * Runs a provider-work burst that stops claiming new items after the first
 * permanent provider failure. In-flight work is allowed to settle.
 *
 * Per-item failures are returned so sibling successes survive. Unclaimed items
 * can inherit a permanent error instead of appearing as empty successes.
 *
 * @template T,U
 * @param {T[]} items Work in claim order.
 * @param {number} limit Maximum concurrent workers.
 * @param {function({item: T, index: number|undefined}): Promise<U>} fn Per-item worker. Provider failures must be returned on `result.error`.
 * @param {object} [options]
 * @param {typeof defaultParallelMap} [options.parallelMap] Injectable executor for tests.
 * @returns {Promise<{results: U[], permanentError: unknown, unclaimed: T[]}>}
 */
export async function runProviderBurst(
  items,
  limit,
  fn,
  { parallelMap = defaultParallelMap } = {},
) {
  let permanentError = null;
  const claimedItems = new Set();

  const results = await parallelMap(
    items,
    limit,
    async (item, index) => {
      // Injected executors may omit the callback index; use item identity.
      claimedItems.add(item);
      return fn({ item, index });
    },
    {
      warmupFirst: true,
      stopBurst: (result) => {
        const error = result?.error;
        if (!permanentError && isPermanentProviderError(error)) permanentError = error;
        return permanentError !== null;
      },
    },
  );

  return {
    results,
    permanentError,
    unclaimed: items.filter((item) => !claimedItems.has(item)),
  };
}
