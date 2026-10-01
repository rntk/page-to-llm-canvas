// Topic-range attempt/parse loop; callbacks own chunk state and side effects.
// Default backoff: baseDelayMs * 2^attemptIndex (zero-based).

export const DEFAULT_RETRY_BASE_DELAY_MS = 2000;

function defaultSleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function computeBackoffDelay(attemptIndex, baseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS) {
  return baseDelayMs * Math.pow(2, attemptIndex);
}

/**
 * Run the attempt/parse/retry cycle for a topic-ranges query.
 *
 * Each attempt calls `callLLM(attemptIndex)`, then `parse(raw)`. Retryable parse
 * errors back off until `maxRetries`; other errors propagate immediately.
 *
 * Await `onAttempt` before dispatch and `onParseRetry` before backoff.
 *
 * @template Raw, T
 * @param {object} opts
 * @param {function(number): Promise<Raw>} opts.callLLM
 * @param {function(Raw): (T | Promise<T>)} opts.parse
 * @param {number} [opts.maxRetries]              total retries after attempt 0
 * @param {number} [opts.baseDelayMs]
 * @param {function(unknown): boolean} [opts.isRetryable]
 * @param {function({attemptIndex: number, baseDelayMs: number, error: unknown}): number} [opts.computeDelay]
 *   Overrides exponential backoff, for example to honor Retry-After.
 * @param {function(number): Promise<void>} [opts.sleep]
 * @param {function({attemptIndex: number, attemptNumber: number}): (void | Promise<void>)} [opts.onAttempt]
 * @param {function({attemptIndex: number, attemptNumber: number, maxRetries: number, error: Error}): (void | Promise<void>)} [opts.onParseRetry]
 * @returns {Promise<T>}
 */
export async function queryTopicRangesWithRetry({
  callLLM,
  parse,
  maxRetries = 0,
  baseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS,
  isRetryable = () => true,
  computeDelay = ({ attemptIndex, baseDelayMs: base }) => computeBackoffDelay(attemptIndex, base),
  sleep = defaultSleep,
  onAttempt,
  onParseRetry,
}) {
  for (let attemptIndex = 0; attemptIndex <= maxRetries; attemptIndex++) {
    const attemptNumber = attemptIndex + 1;
    if (onAttempt) await onAttempt({ attemptIndex, attemptNumber });

    const raw = await callLLM(attemptIndex);

    try {
      return await parse(raw);
    } catch (err) {
      if (!isRetryable(err) || attemptIndex >= maxRetries) throw err;
      if (onParseRetry) {
        await onParseRetry({ attemptIndex, attemptNumber, maxRetries, error: err });
      }
      await sleep(computeDelay({ attemptIndex, baseDelayMs, error: err }));
    }
  }
  // Unreachable: the loop either returns a parsed value or throws.
  /* istanbul ignore next */
  throw new Error('queryTopicRangesWithRetry: exhausted without result');
}
