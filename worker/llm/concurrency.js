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
        // Release the slot before exposing the task's outcome to its caller.
        // Apart from making the limiter's state consistent at settlement time,
        // handling cleanup in the same promise path prevents a throw from
        // tryNext() becoming an ignored rejection from a detached finally().
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
 * Returns a concurrency limiter whose cap can be changed without replacing the
 * queue. Each priority lane remains FIFO. Optional reserved priority capacity
 * keeps background work from occupying every slot, while priority work may use
 * any free slot. When the limit is one, normal work remains enabled and strict
 * reservation is impossible.
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
        next = queue.shift();
      }
      // The entry has started now; its abort listener (if any) no longer
      // needs to watch the queue — the running fn handles its own abort.
      if (next.signal) next.signal.removeEventListener('abort', next.onAbort);
      active++;
      if (!next.priority) activeStandard++;
      Promise.resolve()
        .then(next.fn)
        .then(next.resolve, next.reject)
        .finally(() => {
          active--;
          if (!next.priority) activeStandard--;
          drain();
        });
    }
  }

  return {
    run(fn, signal, { priority = false } = {}) {
      if (signal?.aborted) {
        return Promise.reject(makeAbortError('LLM request aborted'));
      }
      return new Promise((resolve, reject) => {
        const entry = { fn, resolve, reject, signal, priority: priority === true };
        if (signal) {
          entry.onAbort = () => {
            const index = queue.indexOf(entry);
            // Already dequeued (started running): let the running fn's own
            // abort handling take care of it — the slot accounting here must
            // stay untouched since a queued entry never incremented `active`.
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
 * @param {object} [options] When `warmupFirst` is set, the first
 *   item runs to completion before the concurrent burst is released. Every
 *   request in a burst shares the same long prompt prefix, so completing one
 *   first lets the provider commit that prefix to its prompt/KV cache and the
 *   rest reuse it instead of each re-prefilling it from cold. Skipped when there
 *   is fewer than one item to follow, so at least one item always remains for
 *   the parallel phase. A throwing `fn` rejects before the burst starts, just as
 *   it would inside the burst.
 *
 *   Once any worker's `fn` rejects, no worker claims a NEW item afterward —
 *   in-flight items are left to finish, but the failure stops the burst from
 *   growing. The returned promise rejects with that first error as soon as it
 *   occurs.
 *
 *   `stopBurst` covers the callers that record a per-item failure instead of
 *   throwing (so one bad item cannot discard the responses its siblings already
 *   paid for). It is consulted after every settled item, warmup included, and a
 *   truthy answer stops new items from being claimed exactly as a rejection
 *   does — in-flight items are still awaited. This is what keeps a permanent
 *   warmup failure (a 401, an unknown model) from fanning out the whole queue
 *   of doomed requests. The returned promise then RESOLVES, and `results` has
 *   holes where items were never claimed, so callers must treat a missing entry
 *   as "not attempted" rather than as a successful empty result.
 * @param {boolean} [options.warmupFirst]
 * @param {function(U, T, number): boolean} [options.stopBurst]
 * @returns {Promise<Array<U>>}
 */
export async function parallelMap(items, limit, fn, { warmupFirst = false, stopBurst } = {}) {
  const results = new Array(items.length);
  let next = 0;
  let failed = false;
  if (warmupFirst && items.length > 1) {
    results[next] = await fn(items[next], next);
    if (stopBurst && stopBurst(results[next], items[next], next)) return results;
    next++;
  }
  const remaining = Math.max(items.length - next, 1);
  const workers = new Array(Math.min(limit, remaining)).fill(0).map(async () => {
    while (true) {
      if (failed) return;
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
        // Same one-way flag as below, set from a per-item failure the caller
        // recorded rather than threw.
        // eslint-disable-next-line require-atomic-updates
        if (stopBurst && stopBurst(results[i], items[i], i)) failed = true;
      } catch (e) {
        // `failed` is a one-way flag: every write is an unconditional `true`, never
        // derived from a prior read, so concurrent workers racing to set it is harmless.
        // eslint-disable-next-line require-atomic-updates
        failed = true;
        throw e;
      }
    }
  });
  await Promise.all(workers);
  return results;
}
