// The drain contract here is the one piece of this module that was restructured
// rather than moved: `deleteAllExtensionData` snapshots the in-flight completion
// jobs *after* aborting them, and awaits that snapshot so each job reaches its
// terminal metric write before storage is cleared. If `activeCompletionJobs()`
// ever came back empty right after `cancelAll()`, a cancelled request could
// restore metrics data immediately after a full reset returns, with nothing
// failing.
//
// No `chrome` global: the service takes its provider and metrics seams as deps.
import { describe, it, expect, vi } from 'vitest';
import { createChatCompletionService } from './chatCompletionService.js';

/** Builds a service whose provider call resolves only when told to. */
function makeService(overrides = {}) {
  const deferred = [];
  const callLLMDirect =
    overrides.callLLMDirect ||
    vi.fn(
      (args) =>
        new Promise((resolve, reject) => {
          deferred.push({ resolve, reject, args });
        }),
    );
  const recordLlmMetric = overrides.recordLlmMetric || vi.fn(async () => {});
  let now = 1000;
  const service = createChatCompletionService({
    callLLMDirect,
    recordLlmMetric,
    clock: () => now,
    ...overrides.serviceOptions,
  });
  return {
    service,
    callLLMDirect,
    recordLlmMetric,
    deferred,
    advance: (ms) => {
      now += ms;
    },
  };
}

describe('createChatCompletionService (no chrome global)', () => {
  it('rejects a turn with neither prompt nor messages before calling the provider', async () => {
    expect(globalThis.chrome).toBeUndefined();
    const { service, callLLMDirect, recordLlmMetric } = makeService();

    await expect(service.complete({ messages: [] })).resolves.toEqual({
      ok: false,
      error: 'missing prompt or messages',
    });
    expect(callLLMDirect).not.toHaveBeenCalled();
    expect(recordLlmMetric).not.toHaveBeenCalled();
  });

  it('records duration, outcome and the collected sample for a successful call', async () => {
    const { service, recordLlmMetric, advance } = makeService({
      callLLMDirect: vi.fn(async ({ metricsCollector }) => {
        metricsCollector({ promptTokens: 12, cachedTokens: 3 });
        return { ok: true, text: 'hi' };
      }),
    });
    advance(0);

    const result = await service.complete({ prompt: 'hello', taskType: 'chat' });

    expect(result).toEqual({ ok: true, text: 'hi' });
    expect(recordLlmMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        taskType: 'chat',
        promptTokens: 12,
        cachedTokens: 3,
        error: undefined,
      }),
    );
  });

  it('records the provider error on a failed call', async () => {
    const { service, recordLlmMetric } = makeService({
      callLLMDirect: vi.fn(async () => ({ ok: false, error: 'rate limited' })),
    });

    await service.complete({ prompt: 'hello', taskType: 'chat' });

    expect(recordLlmMetric).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, error: 'rate limited' }),
    );
  });

  it('passes no abort signal when the turn is unidentified', async () => {
    const { service, callLLMDirect } = makeService({
      callLLMDirect: vi.fn(async () => ({ ok: true })),
    });

    await service.complete({ prompt: 'hello' });

    expect(callLLMDirect.mock.calls[0][0].signal).toBeUndefined();
    // Nothing to cancel, so a cancel for any turn is a no-op rather than a throw.
    expect(() => service.cancelTurn(undefined)).not.toThrow();
  });

  it('runs provider work through the injected shared limiter', async () => {
    const limit = vi.fn(async (task) => task());
    const { service, callLLMDirect } = makeService({
      callLLMDirect: vi.fn(async () => ({ ok: true })),
      serviceOptions: { limit },
    });

    await service.complete({ prompt: 'hello', chatTurnId: 'turn-a' });

    expect(limit).toHaveBeenCalledTimes(1);
    expect(limit.mock.calls[0][1]).toBeInstanceOf(AbortSignal);
    expect(callLLMDirect).toHaveBeenCalledTimes(1);
  });

  it('aborts only the requested turn, including its fanned-out requests', async () => {
    const { service, deferred } = makeService();

    const a1 = service.complete({ prompt: 'a', chatTurnId: 'turn-a' });
    const a2 = service.complete({ prompt: 'a again', chatTurnId: 'turn-a' });
    const b1 = service.complete({ prompt: 'b', chatTurnId: 'turn-b' });
    await vi.waitFor(() => expect(deferred).toHaveLength(3));

    service.cancelTurn('turn-a');

    expect(deferred[0].args.signal.aborted).toBe(true);
    expect(deferred[1].args.signal.aborted).toBe(true);
    expect(deferred[2].args.signal.aborted).toBe(false);

    for (const d of deferred) d.resolve({ ok: true });
    await Promise.all([a1, a2, b1]);
  });

  it('unregisters a turn even when the provider call rejects', async () => {
    const { service, deferred } = makeService();

    const pending = service.complete({ prompt: 'a', chatTurnId: 'turn-a' });
    await vi.waitFor(() => expect(deferred).toHaveLength(1));
    const { signal } = deferred[0].args;
    deferred[0].reject(new Error('network down'));
    await expect(pending).rejects.toThrow('network down');

    // The controller is gone from the registry, so a late cancel cannot reach
    // it — proven by the signal staying unaborted after cancelTurn.
    service.cancelTurn('turn-a');
    expect(signal.aborted).toBe(false);
  });

  it('still exposes an aborted-but-unsettled job for the reset drain', async () => {
    const { service, deferred, recordLlmMetric } = makeService();

    const pending = service.complete({ prompt: 'a', chatTurnId: 'turn-a' });
    await vi.waitFor(() => expect(deferred).toHaveLength(1));

    // This is the exact order deleteAllExtensionData uses.
    service.cancelAll();
    const jobs = service.activeCompletionJobs();

    expect(deferred[0].args.signal.aborted).toBe(true);
    // The job has NOT settled yet, so it must still be in the drain set.
    expect(jobs).toHaveLength(1);

    deferred[0].resolve({ ok: false, error: 'aborted' });
    await Promise.allSettled(jobs);
    // Awaiting the snapshot is what guarantees the terminal metric write landed
    // before the caller clears storage.
    expect(recordLlmMetric).toHaveBeenCalledTimes(1);
    await pending;
  });

  it('drops settled jobs from the drain set', async () => {
    const { service } = makeService({ callLLMDirect: vi.fn(async () => ({ ok: true })) });

    await service.complete({ prompt: 'a', chatTurnId: 'turn-a' });

    expect(service.activeCompletionJobs()).toEqual([]);
    // Registry is empty too, so a reset has nothing left to abort.
    expect(() => service.cancelAll()).not.toThrow();
  });
});
