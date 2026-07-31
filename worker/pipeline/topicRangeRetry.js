// Shared retry/backoff/parse-error loop for the topic-ranges LLM stage.
//
// Both the primary topic-ranges query (computeTopics) and the oversized-range
// re-split (resplitSegment) follow the same shape: dispatch one or more LLM
// calls for an attempt, collect the raw result, parse it, and on a parse
// error either retry (with exponential backoff) or give up. The two call sites
// differ only in their side effects (which logPipeline stages / updateRecord
// patches they emit) and in how they treat exhaustion (rethrow vs. return),
// so all side effects are injected via callbacks and this module stays pure-ish
// and unit-testable with fakes.
//
// The default backoff matches the original inline loop:
//   delay = baseDelayMs * 2^attemptIndex   (attemptIndex is 0-based)

export const DEFAULT_RETRY_BASE_DELAY_MS = 2000;

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function computeBackoffDelay(attemptIndex, baseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS) {
  return baseDelayMs * Math.pow(2, attemptIndex);
}

/**
 * Run the attempt/parse/retry cycle for a topic-ranges query.
 *
 * On each attempt it calls `callLLM(attemptIndex)` to obtain the combined raw
 * response for that attempt, then `parse(raw)`. A successful parse resolves.
 * A parse error that satisfies `isRetryable(err)` triggers another attempt
 * (after `sleep(delay)`) until `maxRetries` is exhausted, at which point the
 * error is rethrown. Any non-retryable error is rethrown immediately.
 *
 * `onAttempt({ attemptIndex, attemptNumber })` runs before each attempt's LLM
 * dispatch; `onParseRetry({ attemptIndex, attemptNumber, maxRetries, error })`
 * runs after a retryable parse error, before the backoff sleep. Both are
 * awaited so callers can perform async side effects (logging) in order.
 *
 * @template Raw, T
 * @param {object} opts
 * @param {function(number): Promise<Raw>} opts.callLLM
 * @param {function(Raw): (T | Promise<T>)} opts.parse
 * @param {number} [opts.maxRetries]              total retries after attempt 0
 * @param {number} [opts.baseDelayMs]
 * @param {function(unknown): boolean} [opts.isRetryable]
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
      await sleep(computeBackoffDelay(attemptIndex, baseDelayMs));
    }
  }
  // Unreachable: the loop either returns a parsed value or throws.
  /* istanbul ignore next */
  throw new Error('queryTopicRangesWithRetry: exhausted without result');
}
