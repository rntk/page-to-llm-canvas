import { mergeAbortSignals } from '../llm/abortSignals.js';

/**
 * Run a stage in a child cancellation scope. On worker failure, stop siblings,
 * drain them, and rethrow the original failure. The parent signal stays
 * untouched so the pipeline can persist its error transition. The scoped
 * runtime overrides only `signal`; inherited update/log keep the parent's
 * user-cancellation and ownership guards.
 * @param {object} runtime Parent pipeline runtime.
 * @param {Function} parallelMap Injected map implementation.
 * @param {Function} execute Stage callback receiving its runtime and map.
 */
export async function runFailFastStage(runtime, parallelMap, execute) {
  const controller = new AbortController();
  const merged = mergeAbortSignals(runtime.signal, controller.signal);
  // Define rather than assign: the parent runtime's fields are read-only.
  const scopedRuntime = Object.create(runtime, {
    signal: { value: merged.signal, enumerable: true },
  });
  const pending = new Set();
  let firstFailure;
  const scopedMap = (items, limit, fn) =>
    parallelMap(items, limit, (item, index) => {
      const task = (async () => {
        try {
          merged.signal.throwIfAborted();
          return await fn(item, index);
        } catch (error) {
          if (!controller.signal.aborted) {
            firstFailure = error;
            controller.abort();
          }
          throw error;
        }
      })();
      pending.add(task);
      // Both branches handle rejection; never leave a detached rejected promise.
      void task.then(
        () => pending.delete(task),
        () => pending.delete(task),
      );
      return task;
    });
  try {
    return await execute(scopedRuntime, scopedMap);
  } catch (error) {
    controller.abort();
    await Promise.allSettled([...pending]);
    throw firstFailure ?? error;
  } finally {
    merged.dispose();
  }
}
