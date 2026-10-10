import { mergeAbortSignals } from '../llm/abortSignals.js';

/**
 * Run a stage with a child cancellation scope. On worker failure stop siblings,
 * drain their promises, and preserve the original failure. The parent signal
 * remains untouched, allowing the pipeline to persist its error transition.
 * @param {object} runtime Parent pipeline runtime.
 * @param {Function} parallelMap Injected map implementation.
 * @param {Function} execute Stage callback receiving its runtime and map.
 */
export async function executeDecisionStage(runtime, parallelMap, execute) {
  const controller = new AbortController();
  const merged = mergeAbortSignals(runtime.signal, controller.signal);
  const scopedRuntime = Object.create(runtime);
  scopedRuntime.signal = merged.signal;
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
