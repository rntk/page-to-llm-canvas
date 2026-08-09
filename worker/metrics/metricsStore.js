// Shared storage plumbing for the worker/metrics/* modules. Each module keeps
// privacy-safe counters in a single chrome.storage.local key and serializes
// its reads/writes through this factory; see chatTool.js, parser.js, and
// resplit.js for the metric-specific normalize/empty/record logic layered on
// top.

import { getLocal, setLocal } from '../storage/primitives.js';
import { createLogger } from '../../src/shared/runtime/log.js';

/**
 * Coerces a raw stored value (possibly corrupt or missing) into a
 * well-formed metrics object.
 * @callback NormalizeFn
 * @param {unknown} value
 * @returns {object}
 */

/**
 * Returns a fresh empty metrics object.
 * @callback EmptyFn
 * @returns {object}
 */

/**
 * A queued mutation callback: receives the current metrics and returns the
 * object to persist, or a nullish value to skip the write (e.g. an
 * unrecognized sample) without touching storage. May itself return a promise.
 * @callback MutateFn
 * @param {object} metrics
 * @returns {object | null | undefined | Promise<object | null | undefined>}
 */

/**
 * The store factory's return value: a serialized read/write API over one
 * chrome.storage.local key.
 * @typedef {object} MetricsStore
 * @property {function(): Promise<object>} readRaw
 * @property {function(): Promise<object>} getMetrics
 * @property {function(MutateFn): Promise<void>} queueWrite
 * @property {function(): Promise<void>} clear
 */

/**
 * @param {object} options
 * @param {string} options.key chrome.storage.local key this store owns.
 * @param {NormalizeFn} options.normalize Coerces a raw stored
 *   value (possibly corrupt or missing) into a well-formed metrics object.
 * @param {EmptyFn} options.empty Returns a fresh empty metrics object.
 * @param {string} options.label Metric-type name used in console.warn text
 *   (e.g. "chat tool", "parser", "resplit").
 * @returns {MetricsStore}
 */
export function createMetricsStore({ key, normalize, empty, label }) {
  let writeChain = Promise.resolve();
  const log = createLogger(label);

  // Public reads degrade to an empty snapshot on failure (nothing to report
  // yet is a safe default). Queued writes must not use that fallback: writing
  // a mutation of an empty snapshot after a transient read failure would erase
  // counters that remain in storage. They still warn and resolve so optional
  // telemetry cannot fail the operation it measures.
  // clear() is different because it is a user-requested mutation whose failure
  // must remain observable to the caller.
  async function readRaw() {
    try {
      return await readRawOrThrow();
    } catch (error) {
      log.warn('metrics read failed:', error);
      return empty();
    }
  }

  async function readRawOrThrow() {
    const items = await getLocal(key);
    return normalize(items?.[key]);
  }

  async function getMetrics() {
    if (typeof chrome === 'undefined' || !chrome?.storage?.local) return empty();
    return readRaw();
  }

  /**
   * Queue a read-modify-write against this store's key, serialized after any
   * writes already queued. `mutate` receives the current metrics and should
   * return the object to persist, or a nullish value to skip the write
   * (e.g. an unrecognized sample) without touching storage.
   * Failures are logged and swallowed so metrics cannot break pipeline work.
   * @param {MutateFn} mutate
   * @returns {Promise<void>} Settles after the queued write attempt finishes.
   */
  function queueWrite(mutate) {
    writeChain = writeChain
      .then(async () => {
        if (typeof chrome === 'undefined' || !chrome?.storage?.local) return;
        const metrics = await readRawOrThrow();
        const next = await mutate(metrics);
        if (next == null) return;
        await setLocal({ [key]: next });
      })
      .catch((error) => log.warn('metrics record failed:', error));
    return writeChain;
  }

  function clear() {
    // Split the chain so a failed clear rejects for the caller while still
    // keeping subsequent queued writes alive (mirrors primitives.js's
    // queuedUpdate: the shared writeChain must never itself become rejected).
    const next = writeChain.then(() => setLocal({ [key]: empty() }));
    writeChain = next.catch(() => {});
    return next;
  }

  return { readRaw, getMetrics, queueWrite, clear };
}
