// Cancellation detection shared by the pipeline stages: tells a user-driven
// cancellation apart from a genuine provider/transport failure, since the two
// must not be conflated in the record's error log or pipeline metrics.

const CANCELLATION = Symbol.for('pipeline.cancellation');

/** Marks an error as this pipeline's own cancellation, for exits that don't
 * abort the signal — e.g. losing the record to a newer run's CAS in
 * pipelineRuntime — where abort shape alone can't be trusted.
 * @param {Error} error Error created for a cancellation exit.
 * @returns {Error} The same error, marked when it accepts the marker.
 */
export function markCancellation(error) {
  if (error && (typeof error === 'object' || typeof error === 'function')) {
    try {
      error[CANCELLATION] = true;
    } catch (_) {
      /* Frozen or otherwise unwritable: abort shape remains the fallback. */
    }
  }
  return error;
}

/** Detects cancellation, as opposed to a genuine provider/transport failure.
 * With a runtime, abort shape alone isn't enough: an AbortError only counts as
 * cancellation if this run's signal actually aborted or the error carries the
 * marker (see markCancellation) — otherwise an unrelated abort-shaped error,
 * like a transport timeout, would be swallowed. An aborted signal alone isn't
 * enough either, since an unrelated failure can still settle after
 * cancellation wins the race.
 * @param {unknown} error Error thrown by an LLM call.
 * @param {PipelineRuntime} [runtime] Pipeline runtime. Omit it only where no
 *   run context exists; abort shape is then taken at face value.
 */
export function isCancellationError(error, runtime) {
  const abortReason = runtime?.signal?.aborted ? runtime.signal.reason : undefined;
  const trustAbortShape = !runtime || runtime.signal?.aborted === true;
  let current = error;
  const seen = new Set();
  while (current && (typeof current === 'object' || typeof current === 'function')) {
    if (seen.has(current)) break;
    seen.add(current);
    if (current[CANCELLATION] === true) return true;
    if (trustAbortShape && (current.name === 'AbortError' || current.code === 'ABORT_ERR')) {
      return true;
    }
    if (abortReason !== undefined && current === abortReason) return true;
    current = current.cause;
  }
  return false;
}

/**
 * Stops work at an explicit stage boundary when the runtime has been aborted.
 * No competing error to preserve here, so the signal alone is authoritative.
 * @param {PipelineRuntime} runtime Pipeline runtime.
 * @param {string} [message] Stage-specific message for the normalized error.
 */
export function throwIfCancelled(runtime, message = 'pipeline aborted') {
  if (!runtime?.signal?.aborted) return;
  const reason = runtime.signal.reason;
  if (reason?.name === 'AbortError' || reason?.code === 'ABORT_ERR') throw reason;
  const aborted = new Error(message, reason === undefined ? undefined : { cause: reason });
  aborted.name = 'AbortError';
  throw markCancellation(aborted);
}

/** Rethrows errors that must escape a cancellation-sensitive stage catch.
 * Actual cancellation is normalized to AbortError; an unrelated error that
 * settles after the signal aborts is rethrown as itself, rather than letting
 * the stage's next log/update replace it with an AbortError.
 * @param {unknown} error Error thrown by an LLM call.
 * @param {PipelineRuntime} runtime Pipeline runtime.
 * @param {string} [message] Stage-specific message for the normalized error.
 */
export function rethrowIfCancelled(error, runtime, message = 'pipeline aborted') {
  if (!isCancellationError(error, runtime)) {
    if (runtime?.signal?.aborted) throw error;
    return;
  }
  if (error && error.name === 'AbortError') throw error;
  const aborted = new Error(message, { cause: error });
  aborted.name = 'AbortError';
  throw markCancellation(aborted);
}
