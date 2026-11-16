// Generic concurrency primitives. Used by the LLM boundary and by pipeline
// stages, but none of them know anything about providers or prompts.

import { makeAbortError } from './abortSignals.js';

function normalizeLimiterLimit(value) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

/**
 * Returns a function that runs async tasks with at most `limit` in flight.
 * Tasks beyond the limit queue in FIFO order. Unlike parallelMap this gates
 * individually submitted tasks, so it suits recursive traversals where the
 * full task list is not known up front.
 *
 * @param {number} limit
 * @returns {function(function(): Promise<*>): Promise<*>}
 */
export function createLimiter(limit) {
  const normalizedLimit = normalizeLimiterLimit(limit);
  let active = 0;
  const queue = [];

  function tryNext() {
    if (active >= normalizedLimit) return;
    const next = queue.shift();
    if (!next) return;
    active++;
    next();
  }

  return function run(fn) {
    return new Promise((resolve, reject) => {
      queue.push(() => {
        // Release the slot before exposing the outcome; cleanup in the same
        // promise path keeps a tryNext() throw from becoming an ignored rejection.
        const settleAfterCleanup = (settle, value) => {
          try {
            active--;
            tryNext();
          } catch (error) {
            reject(error);
            return;
          }
          settle(value);
        };

        Promise.resolve()
          .then(fn)
          .then(
            (value) => settleAfterCleanup(resolve, value),
            (error) => settleAfterCleanup(reject, error),
          );
      });
      tryNext();
    });
  };
}

/**
 * Returns a concurrency limiter whose cap can change without replacing the
 * queue. Priority tasks stay FIFO. Reserved priority capacity keeps background
 * work from occupying every slot, while priority work may use any free slot;
 * at limit one, normal work stays enabled and strict reservation is impossible.
 * Standard tasks may supply a providerKey and fairnessKey. When servers
 * compete, providers below half (rounded up) of standard capacity are preferred;
 * otherwise idle slots are used. Eligible records rotate; requests within a
 * record stay FIFO. Running tasks are never preempted.
 *
 * @param {number} initialLimit
 * @param {object} [options]
 * @param {number} [options.reservedPrioritySlots=0]
 * @returns {{run: function(function(): Promise<*>, AbortSignal, object=): Promise<*>, setLimit: function(number): void}}
 */
export function createAdjustableLimiter(initialLimit, { reservedPrioritySlots = 0 } = {}) {
  let limit = normalizeLimiterLimit(initialLimit);
  const priorityReserve = Math.max(0, Math.floor(Number(reservedPrioritySlots)) || 0);
  let active = 0;
  let activeStandard = 0;
  const queue = [];
  const activeProviders = new Map();

  function drain() {
    while (active < limit && queue.length > 0) {
      const priorityIndex = queue.findIndex((entry) => entry.priority);
      let next;
      if (priorityIndex >= 0) {
        next = queue.splice(priorityIndex, 1)[0];
      } else {
        const standardLimit =
          limit === 1 ? 1 : Math.max(1, limit - Math.min(priorityReserve, limit - 1));
        if (activeStandard >= standardLimit) return;
        const providerLimit = Math.max(1, Math.ceil(standardLimit / 2));
        const eligible = (entry) =>
          !entry.providerKey || (activeProviders.get(entry.providerKey) ?? 0) < providerLimit;
        const preferredIndex = queue.findIndex(eligible);
        // A provider share is a preference, not an idle reservation: if no
        // underserved provider can use this slot, queued work takes it.
        const index = preferredIndex >= 0 ? preferredIndex : 0;
        next = queue.splice(index, 1)[0];
        if (next.fairnessKey != null) {
          // Round-robin: move this record's remaining requests behind its peers.
          const peers = queue.filter((entry) => entry.fairnessKey !== next.fairnessKey);
          const siblings = queue.filter((entry) => entry.fairnessKey === next.fairnessKey);
          queue.splice(0, queue.length, ...peers, ...siblings);
        }
      }
      // Started: the running fn handles its own abort, so stop watching the queue.
      if (next.signal) next.signal.removeEventListener('abort', next.onAbort);
      active++;
      if (!next.priority) activeStandard++;
      if (!next.priority && next.providerKey) {
        activeProviders.set(next.providerKey, (activeProviders.get(next.providerKey) ?? 0) + 1);
      }
      Promise.resolve()
        .then(next.fn)
        .then(next.resolve, next.reject)
        .finally(() => {
          active--;
          if (!next.priority) activeStandard--;
          if (!next.priority && next.providerKey) {
            const count = activeProviders.get(next.providerKey) - 1;
            if (count === 0) activeProviders.delete(next.providerKey);
            else activeProviders.set(next.providerKey, count);
          }
          drain();
        });
    }
  }

  return {
    run(fn, signal, { priority = false, providerKey, fairnessKey } = {}) {
      if (signal?.aborted) {
        return Promise.reject(makeAbortError('LLM request aborted'));
      }
      return new Promise((resolve, reject) => {
        const entry = {
          fn,
          resolve,
          reject,
          signal,
          priority: priority === true,
          providerKey,
          fairnessKey,
        };
        if (signal) {
          entry.onAbort = () => {
            const index = queue.indexOf(entry);
            // Already running: its own abort handling applies; leave slot
            // accounting alone since a queued entry never incremented `active`.
            if (index === -1) return;
            queue.splice(index, 1);
            reject(makeAbortError('LLM request aborted'));
          };
          signal.addEventListener('abort', entry.onAbort, { once: true });
        }
        queue.push(entry);
        drain();
      });
    },
    setLimit(nextLimit) {
      limit = normalizeLimiterLimit(nextLimit);
      drain();
    },
  };
}

/**
 * @template T,U
 * @param {Array<T>} items
 * @param {number} limit
 * @param {function(T, number): Promise<U>} fn
 * @param {object} [options] With `warmupFirst`, the first item runs to
 *   completion before the burst is released: burst requests share a long prompt
 *   prefix, so the provider can commit it to its prompt/KV cache for the rest.
 *   Skipped unless more than one item exists. A throwing `fn` rejects before
 *   the burst starts.
 *
 *   Once any `fn` rejects, no worker claims a new item; in-flight items finish
 *   and the returned promise rejects with the first error immediately.
 *
 *   `stopBurst` serves callers that record per-item failures instead of
 *   throwing (so siblings' paid-for responses are kept). It is consulted after
 *   every settled item, warmup included; a truthy answer stops new claims like
 *   a rejection, but in-flight items are awaited. This stops a permanent warmup
 *   failure (401, unknown model) from fanning out doomed requests. The promise
 *   then RESOLVES with holes in `results` for unclaimed items, which callers
 *   must treat as "not attempted", not as an empty success.
 * @param {boolean} [options.warmupFirst]
 * @param {function(U, T, number): boolean} [options.stopBurst]
 * @returns {Promise<Array<U>>}
 */
export async function parallelMap(items, limit, fn, { warmupFirst = false, stopBurst } = {}) {
  const normalizedLimit = normalizeLimiterLimit(limit);
  const results = new Array(items.length);
  let next = 0;
  let failed = false;
  if (warmupFirst && items.length > 1) {
    results[next] = await fn(items[next], next);
    if (stopBurst && stopBurst(results[next], items[next], next)) return results;
    next++;
  }
  const remaining = Math.max(items.length - next, 1);
  const workers = new Array(Math.min(normalizedLimit, remaining)).fill(0).map(async () => {
    while (true) {
      if (failed) return;
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
        // Same one-way flag as below, set for a recorded (not thrown) failure.
        // eslint-disable-next-line require-atomic-updates
        if (stopBurst && stopBurst(results[i], items[i], i)) failed = true;
      } catch (e) {
        // One-way flag: writes are unconditional `true`, so racing workers are harmless.
        // eslint-disable-next-line require-atomic-updates
        failed = true;
        throw e;
      }
    }
  });
  await Promise.all(workers);
  return results;
}
