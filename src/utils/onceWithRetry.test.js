import { describe, expect, it, vi } from 'vitest';
import { onceWithRetry } from './onceWithRetry.js';

describe('onceWithRetry', () => {
  it('shares one promise across calls once it resolves', async () => {
    const fn = vi.fn().mockResolvedValue('page');
    const load = onceWithRetry(fn);
    expect(load()).toBe(load());
    await expect(load()).resolves.toBe('page');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('calls again after a rejection', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('not ready')).mockResolvedValue('page');
    const load = onceWithRetry(fn);
    await expect(load()).rejects.toThrow('not ready');
    await expect(load()).resolves.toBe('page');
    await expect(load()).resolves.toBe('page');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
