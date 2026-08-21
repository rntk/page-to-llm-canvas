import { parallelMap as defaultParallelMap } from '../llm/llm.js';
import { isPermanentProviderError } from './providerFailure.js';

/**
 * Runs a provider-work burst that stops claiming new items after the first
 * permanent provider failure. In-flight work is allowed to settle.
 *
 * Callers deliberately return item failures instead of throwing so successful
 * siblings are not discarded. A result's optional `error` field is inspected
 * centrally; the returned `unclaimed` items can then inherit a permanent
 * failure instead of being mistaken for successful empty work.
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
      // Item identity is part of every parallelMap-compatible executor's
      // callback contract; index is useful metadata but injectable stand-ins
      // are not trusted to supply it.
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
