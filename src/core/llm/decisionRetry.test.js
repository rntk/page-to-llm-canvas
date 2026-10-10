import { describe, it, expect, vi } from 'vitest';
import { executeDecisionWithRetry } from './decisionRetry.js';

describe('decision transport retry policy', () => {
  it.each([0, 1.5, NaN])(
    'rejects an invalid attempt budget %s before transport',
    async (maxAttempts) => {
      const execute = vi.fn();
      await expect(executeDecisionWithRetry(execute, { maxAttempts })).rejects.toThrow(
        'positive integer',
      );
      expect(execute).not.toHaveBeenCalled();
    },
  );
  it('honors Retry-After, caps delays, and jitters exponential backoff', async () => {
    const execute = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('busy'), { status: 429, retryAfterMs: 2000 }))
      .mockRejectedValueOnce(
        Object.assign(new Error('unavailable'), { status: 503, retryAfterMs: 120000 }),
      )
      .mockResolvedValue('ok');
    const sleep = vi.fn(async () => {});
    expect(await executeDecisionWithRetry(execute, { sleep, random: () => 0 })).toBe('ok');
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([2000, 60000]);
    const network = vi.fn().mockRejectedValueOnce(new TypeError('network')).mockResolvedValue('ok');
    await executeDecisionWithRetry(network, { sleep, random: () => 1 });
    expect(sleep).toHaveBeenLastCalledWith(750, undefined);
  });

  it('retries an overloaded TypeSafe API (529)', async () => {
    const execute = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('overloaded'), { status: 529 }))
      .mockResolvedValue('ok');
    expect(await executeDecisionWithRetry(execute, { sleep: async () => {} })).toBe('ok');
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it.each([400, 401, 403, 413, 422])('does not retry permanent HTTP %s', async (status) => {
    const error = Object.assign(new Error('failed'), { status });
    const execute = vi.fn().mockRejectedValue(error);
    await expect(executeDecisionWithRetry(execute)).rejects.toBe(error);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('cancels backoff without launching another attempt', async () => {
    const controller = new AbortController();
    const execute = vi.fn().mockRejectedValue(Object.assign(new Error('busy'), { status: 503 }));
    await expect(
      executeDecisionWithRetry(execute, {
        signal: controller.signal,
        onRetry: async () => controller.abort(),
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
