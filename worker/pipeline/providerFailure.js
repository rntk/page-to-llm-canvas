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

/** Walks an error's `cause` chain (guarding against cycles), calling `check`
 * on each node. The first node where `check` returns a value other than
 * `undefined` stops the walk and that value is returned. If the chain is
 * exhausted without a definitive result, returns `false`.
 * @param {unknown} error Error to walk.
 * @param {function(object): *} check Per-node classifier.
 */
function walkCauseChain(error, check) {
  let current = error;
  const seen = new Set();
  while (current && (typeof current === 'object' || typeof current === 'function')) {
    if (seen.has(current)) break;
    seen.add(current);
    const result = check(current);
    if (result !== undefined) return result;
    current = current.cause;
  }
  return false;
}

/**
 * Mirrors callLLMWithRetry's own classification (worker/llm/llm.js): a 4xx
 * other than 408 (timeout) or 429 (rate limit) reflects a request that will
 * never succeed, so re-issuing it — on a stage retry or across the siblings of
 * a concurrent burst — only spends money to collect the same rejection.
 *
 * The `cause` chain is walked for the same reason `isProviderFailure` walks it:
 * `markProviderFailure` wraps an error it cannot mutate, and the wrapper does
 * not carry the original's `status`/`retryable`. The OUTERMOST classification
 * wins: the first `status` found ends the walk, so a wrapper that reports its
 * own 5xx stays retryable even over a 4xx cause.
 * @param {unknown} error Error thrown by a provider call.
 */
export function isPermanentProviderError(error) {
  return walkCauseChain(error, (current) => {
    if (current.retryable === false) return true;
    const status = current.status;
    if (Number.isFinite(status)) {
      return status >= 400 && status < 500 && status !== 408 && status !== 429;
    }
    return undefined;
  });
}

/** Detects an error that a provider call marked as its own failure.
 * The `cause` chain is walked because a stage may wrap the original rejection
 * before it reaches the catch that decides whether to park or fail the record.
 * @param {unknown} error Error caught by a pipeline stage.
 */
export function isProviderFailure(error) {
  return walkCauseChain(error, (current) =>
    current[PROVIDER_FAILURE] === true ? true : undefined,
  );
}
