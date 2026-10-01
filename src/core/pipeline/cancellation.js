// Distinguish pipeline cancellation from provider and transport failures.

const CANCELLATION = Symbol.for('pipeline.cancellation');

/** Mark cancellation exits that do not abort the signal, such as losing run
 * ownership to a newer pipeline instance.
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

/** Detect cancellation through an explicit marker or an aborted signal paired
 * with abort-shaped error. This preserves transport timeouts and unrelated
 * failures that settle after a racing abort.
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

/** Normalize cancellation to AbortError while preserving unrelated failures
 * that settle after the signal aborts.
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
