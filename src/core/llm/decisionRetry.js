import { sleepWithAbort } from './abortSignals.js';

export const DECISION_MAX_ATTEMPTS = 3;
// 529 is the TypeSafe API's "overloaded" status.
const TRANSIENT_STATUSES = new Set([429, 502, 503, 504, 529]);

/**
 * Execute a decision request with bounded transport retries. Each attempt calls
 * the supplied executor separately, so backoff never occupies a request slot.
 * Domain validation and input shrinking belong to the caller.
 * @param {Function} execute One transport attempt.
 * @param {object} [options] Cancellation, retry policy, and injectable timing.
 */
export async function executeDecisionWithRetry(
  execute,
  {
    signal,
    maxAttempts = DECISION_MAX_ATTEMPTS,
    sleep = sleepWithAbort,
    random = Math.random,
    onRetry = async () => {},
  } = {},
) {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('maxAttempts must be a positive integer');
  }
  for (let attempt = 1; ; attempt++) {
    signal?.throwIfAborted();
    try {
      return await execute(attempt);
    } catch (error) {
      if (
        signal?.aborted ||
        attempt >= maxAttempts ||
        (!TRANSIENT_STATUSES.has(error?.status) && !(error instanceof TypeError))
      )
        throw error;
      const backoff = 500 * 2 ** (attempt - 1) * (0.5 + random());
      const delayMs = Math.min(60_000, Math.max(backoff, error?.retryAfterMs || 0));
      await onRetry({ attempt, delayMs, error });
      await sleep(delayMs, signal);
    }
  }
}
