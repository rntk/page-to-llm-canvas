import { describe, it, expect, vi } from 'vitest';
import {
  queryTopicRangesWithRetry,
  computeBackoffDelay,
  DEFAULT_RETRY_BASE_DELAY_MS,
} from './topicRangeRetry.js';

// Mirror of the orchestrator's TopicParseError shape so we can exercise the
// isRetryable gate exactly as computeTopics does (retry only on parse errors).
class TopicParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TopicParseError';
  }
}

describe('computeBackoffDelay', () => {
  it('matches the orchestrator base * 2^attemptIndex schedule', () => {
    expect(computeBackoffDelay(0)).toBe(DEFAULT_RETRY_BASE_DELAY_MS);
    expect(computeBackoffDelay(1)).toBe(DEFAULT_RETRY_BASE_DELAY_MS * 2);
    expect(computeBackoffDelay(2)).toBe(DEFAULT_RETRY_BASE_DELAY_MS * 4);
    expect(computeBackoffDelay(2, 1000)).toBe(4000);
  });
});

describe('queryTopicRangesWithRetry', () => {
  it('succeeds on the first attempt without retrying', async () => {
    const callLLM = vi.fn(async () => 'raw-response');
    const parse = vi.fn((raw) => ({ parsed: raw }));
    const sleep = vi.fn(async () => {});
    const onParseRetry = vi.fn();

    const result = await queryTopicRangesWithRetry({
      callLLM,
      parse,
      maxRetries: 3,
      sleep,
      onParseRetry,
    });

    expect(result).toEqual({ parsed: 'raw-response' });
    expect(callLLM).toHaveBeenCalledTimes(1);
    expect(callLLM).toHaveBeenCalledWith(0);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(parse).toHaveBeenCalledWith('raw-response');
    expect(sleep).not.toHaveBeenCalled();
    expect(onParseRetry).not.toHaveBeenCalled();
  });

  it('retries after a parse error, applying exponential backoff via injected sleep', async () => {
    const callLLM = vi.fn(async (attemptIndex) => `resp-${attemptIndex}`);
    const parse = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new TopicParseError('bad 1');
      })
      .mockImplementationOnce(() => {
        throw new TopicParseError('bad 2');
      })
      .mockImplementationOnce(() => 'ok');
    const sleep = vi.fn(async () => {});

    const result = await queryTopicRangesWithRetry({
      callLLM,
      parse,
      maxRetries: 3,
      baseDelayMs: 2000,
      isRetryable: (e) => e instanceof TopicParseError,
      sleep,
    });

    expect(result).toBe('ok');
    expect(callLLM).toHaveBeenCalledTimes(3);
    // attemptIndex passed through in order.
    expect(callLLM.mock.calls.map((c) => c[0])).toEqual([0, 1, 2]);
    // Backoff doubled per attempt: 2000 then 4000.
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([2000, 4000]);
  });

  it('rethrows the original error type/message once retries are exhausted', async () => {
    const err = new TopicParseError('no parseable topic ranges');
    const callLLM = vi.fn(async () => 'junk');
    const parse = vi.fn(() => {
      throw err;
    });
    const sleep = vi.fn(async () => {});

    await expect(
      queryTopicRangesWithRetry({
        callLLM,
        parse,
        maxRetries: 3,
        isRetryable: (e) => e instanceof TopicParseError,
        sleep,
      }),
    ).rejects.toBe(err);

    // attempts 0..3 inclusive = 4 LLM dispatches, 3 backoff sleeps between them.
    expect(callLLM).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([2000, 4000, 8000]);
  });

  it('rethrows a non-retryable error immediately without sleeping (resplit semantics)', async () => {
    const err = new TypeError('Unexpected');
    const callLLM = vi.fn(async () => 'junk');
    const parse = vi.fn(() => {
      throw err;
    });
    const sleep = vi.fn(async () => {});

    await expect(
      queryTopicRangesWithRetry({
        callLLM,
        parse,
        maxRetries: 3,
        isRetryable: (e) => e instanceof TopicParseError,
        sleep,
      }),
    ).rejects.toThrow('Unexpected');

    expect(callLLM).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('single-attempt mode (maxRetries 0) rethrows the first parse error without retry', async () => {
    // Mirrors resplitSegment: one shot, the caller turns the throw into a
    // null fallback. No retry, no sleep, regardless of isRetryable.
    const err = new TopicParseError('still one topic');
    const callLLM = vi.fn(async () => 'raw');
    const parse = vi.fn(() => {
      throw err;
    });
    const sleep = vi.fn(async () => {});

    await expect(
      queryTopicRangesWithRetry({ callLLM, parse, maxRetries: 0, sleep }),
    ).rejects.toBe(err);
    expect(callLLM).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('invokes onAttempt before each LLM dispatch with the correct args and order', async () => {
    const order = [];
    const callLLM = vi.fn(async (attemptIndex) => {
      order.push(`llm:${attemptIndex}`);
      return `resp-${attemptIndex}`;
    });
    const parse = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new TopicParseError('retry me');
      })
      .mockImplementationOnce(() => 'done');
    const sleep = vi.fn(async () => {});
    const onAttempt = vi.fn(async ({ attemptIndex }) => {
      order.push(`attempt:${attemptIndex}`);
    });
    const onParseRetry = vi.fn(async ({ attemptIndex }) => {
      order.push(`retry:${attemptIndex}`);
    });

    const result = await queryTopicRangesWithRetry({
      callLLM,
      parse,
      maxRetries: 2,
      isRetryable: (e) => e instanceof TopicParseError,
      sleep,
      onAttempt,
      onParseRetry,
    });

    expect(result).toBe('done');
    expect(onAttempt.mock.calls.map((c) => c[0])).toEqual([
      { attemptIndex: 0, attemptNumber: 1 },
      { attemptIndex: 1, attemptNumber: 2 },
    ]);
    expect(onParseRetry).toHaveBeenCalledTimes(1);
    expect(onParseRetry.mock.calls[0][0]).toMatchObject({
      attemptIndex: 0,
      attemptNumber: 1,
      maxRetries: 2,
    });
    expect(onParseRetry.mock.calls[0][0].error).toBeInstanceOf(TopicParseError);
    // onAttempt fires before its LLM dispatch; onParseRetry fires before the
    // next attempt's onAttempt.
    expect(order).toEqual([
      'attempt:0',
      'llm:0',
      'retry:0',
      'attempt:1',
      'llm:1',
    ]);
  });

  it('defaults to a real-timer sleep when none is injected', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn) => {
      if (typeof fn === 'function') fn();
      return 0;
    });
    const parse = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new TopicParseError('retry');
      })
      .mockImplementationOnce(() => 'ok');

    const result = await queryTopicRangesWithRetry({
      callLLM: async () => 'raw',
      parse,
      maxRetries: 1,
    });

    expect(result).toBe('ok');
    expect(setTimeoutSpy).toHaveBeenCalled();
    setTimeoutSpy.mockRestore();
  });
});
