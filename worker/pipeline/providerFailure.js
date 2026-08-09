// Provider-failure marking shared by the pipeline stages: distinguishes a
// genuine provider/transport failure (retryable) from a bug in our own code
// (must surface as a pipeline error, not a Retry-button failure).

const PROVIDER_FAILURE = Symbol.for('pipeline.providerFailure');

/** Marks an error as a genuine provider/transport failure.
 * Values that can't carry the marker (primitives, frozen objects) are wrapped
 * in an Error instead of mutated, keeping the original as `cause`.
 * @param {unknown} error Error thrown by an LLM call.
 * @returns {unknown} The marked error, or a marked wrapper around it.
 */
export function markProviderFailure(error) {
  if (error && (typeof error === 'object' || typeof error === 'function')) {
    try {
      error[PROVIDER_FAILURE] = true;
      if (error[PROVIDER_FAILURE] === true) return error;
    } catch (_) {
      /* Frozen or otherwise unwritable: fall through to the wrapper. */
    }
  }
  const wrapped = new Error((error && error.message) || String(error), { cause: error });
  // Cancellation is recognized by name/code along the same cause chain, so the
  // wrapper must not hide an AbortError from `isCancellationError`.
  if (error && error.name) wrapped.name = error.name;
  if (error && error.code !== undefined) wrapped.code = error.code;
  wrapped[PROVIDER_FAILURE] = true;
  return wrapped;
}

/** Detects an error that a provider call marked as its own failure.
 * The `cause` chain is walked because a stage may wrap the original rejection
 * before it reaches the catch that decides whether to park or fail the record.
 * @param {unknown} error Error caught by a pipeline stage.
 */
export function isProviderFailure(error) {
  let current = error;
  const seen = new Set();
  while (current && (typeof current === 'object' || typeof current === 'function')) {
    if (seen.has(current)) break;
    seen.add(current);
    if (current[PROVIDER_FAILURE] === true) return true;
    current = current.cause;
  }
  return false;
}
