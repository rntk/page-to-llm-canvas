import { describe, it, expect, vi } from 'vitest';

// Re-imported per test so each case gets a fresh module instance.
async function getAbortSignals() {
  vi.resetModules();
  return await import('./abortSignals.js');
}

describe('mergeAbortSignals', () => {
  it('handles 0 signals', async () => {
    const { mergeAbortSignals } = await getAbortSignals();
    const merged = mergeAbortSignals();
    expect(merged.signal).toBeUndefined();
    expect(typeof merged.dispose).toBe('function');
    merged.dispose();
  });

  it('handles 1 signal', async () => {
    const { mergeAbortSignals } = await getAbortSignals();
    const controller = new AbortController();
    const merged = mergeAbortSignals(controller.signal);
    expect(merged.signal).toBe(controller.signal);
    expect(typeof merged.dispose).toBe('function');
    merged.dispose();
  });

  it('handles multiple signals (with AbortSignal.any supported)', async () => {
    const { mergeAbortSignals } = await getAbortSignals();
    const controller1 = new AbortController();
    const controller2 = new AbortController();
    const merged = mergeAbortSignals(controller1.signal, controller2.signal);
    expect(merged.signal.aborted).toBe(false);
    controller1.abort();
    expect(merged.signal.aborted).toBe(true);
    merged.dispose();
  });

  it('handles multiple signals (fallback logic when AbortSignal.any is absent)', async () => {
    const { mergeAbortSignals } = await getAbortSignals();
    const originalAny = AbortSignal.any;
    Object.defineProperty(AbortSignal, 'any', {
      value: undefined,
      configurable: true,
    });

    try {
      const controller1 = new AbortController();
      const controller2 = new AbortController();
      const merged = mergeAbortSignals(controller1.signal, controller2.signal);
      expect(merged.signal.aborted).toBe(false);
      controller2.abort();
      expect(merged.signal.aborted).toBe(true);
      merged.dispose();

      // Test pre-aborted signal path in fallback logic
      const preAborted = new AbortController();
      preAborted.abort();
      const controller3 = new AbortController();
      const merged2 = mergeAbortSignals(preAborted.signal, controller3.signal);
      expect(merged2.signal.aborted).toBe(true);
      merged2.dispose();
    } finally {
      Object.defineProperty(AbortSignal, 'any', {
        value: originalAny,
        configurable: true,
      });
    }
  });
});

describe('createRequestTimeoutSignal', () => {
  it('creates a timeout signal and fires abort after ms', async () => {
    const { createRequestTimeoutSignal } = await getAbortSignals();
    vi.useFakeTimers();
    const timeout = createRequestTimeoutSignal(1000);
    expect(timeout.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(timeout.signal.aborted).toBe(true);
    expect(timeout.signal.reason?.name).toBe('TimeoutError');
    vi.useRealTimers();
  });

  it('does not fire abort if disposed before timeout', async () => {
    const { createRequestTimeoutSignal } = await getAbortSignals();
    vi.useFakeTimers();
    const timeout = createRequestTimeoutSignal(1000);
    timeout.dispose();
    vi.advanceTimersByTime(1000);
    expect(timeout.signal.aborted).toBe(false);
    vi.useRealTimers();
  });
});

describe('sleepWithAbort', () => {
  it('resolves after ms when no signal is present', async () => {
    const { sleepWithAbort } = await getAbortSignals();
    vi.useFakeTimers();
    const promise = sleepWithAbort(500);
    vi.advanceTimersByTime(500);
    await expect(promise).resolves.toBeUndefined();
    vi.useRealTimers();
  });

  it('rejects immediately if signal is already aborted', async () => {
    const { sleepWithAbort } = await getAbortSignals();
    const controller = new AbortController();
    controller.abort();
    await expect(sleepWithAbort(500, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('rejects if signal aborts during sleep', async () => {
    const { sleepWithAbort } = await getAbortSignals();
    vi.useFakeTimers();
    const controller = new AbortController();
    const promise = sleepWithAbort(1000, controller.signal);
    vi.advanceTimersByTime(500);
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    vi.useRealTimers();
  });
});
