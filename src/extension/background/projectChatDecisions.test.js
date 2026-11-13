import { describe, it, expect, vi } from 'vitest';
import { createProjectChatDecisionService } from './projectChatDecisions.js';

const PROVIDER = {
  id: 'd1',
  type: 'llama_decision',
  name: 'Decisions',
  model: 'm',
  url: 'http://localhost:8080',
  token: 'sekret',
  contextWindowTokens: 4096,
};
const QUESTIONS = { relevant: { type: 'choice' } };

function make({ provider = PROVIDER, decide, ...overrides } = {}) {
  const client = { decide: decide ?? vi.fn(async () => ({ answers: { relevant: 'yes' } })) };
  const createDecisionClient = vi.fn(() => client);
  const limit = vi.fn((task) => task());
  const wrapDecide = vi.fn((fn) => fn);
  const service = createProjectChatDecisionService({
    getPageScanProvider: vi.fn(async () => provider),
    createDecisionClient,
    limit,
    wrapDecide,
    retryOptions: { sleep: async () => {}, random: () => 0 },
    ...overrides,
  });
  return { service, client, createDecisionClient, limit, wrapDecide };
}

describe('createProjectChatDecisionService', () => {
  it('reports the llm mode without a selected provider', async () => {
    const { service } = make({ provider: null });
    expect(await service.getConfig()).toEqual({ ok: true, mode: 'llm' });
  });

  it('reports the decision mode with the provider context window and no secrets', async () => {
    const { service } = make();
    const config = await service.getConfig();
    expect(config).toEqual({ ok: true, mode: 'decision', contextWindowTokens: 4096 });
    expect(JSON.stringify(config)).not.toContain('sekret');
  });

  it('omits the context window when unset and falls back when the client rejects the provider', async () => {
    expect(
      await make({ provider: { ...PROVIDER, contextWindowTokens: undefined } }).service.getConfig(),
    ).toEqual({
      ok: true,
      mode: 'decision',
    });
    const { service, createDecisionClient } = make();
    createDecisionClient.mockImplementation(() => {
      throw new Error('bad url');
    });
    expect(await service.getConfig()).toEqual({ ok: true, mode: 'llm' });
  });

  it('returns the answers through the limiter and telemetry wrapper', async () => {
    const decide = vi.fn(async () => ({
      answers: { relevant: 'yes' },
      model: 'served',
      usage: { tokens: 3 },
    }));
    const { service, createDecisionClient, limit, wrapDecide } = make({
      decide,
      getVerboseLogs: () => true,
    });
    const result = await service.decide({ state: 'page', questions: QUESTIONS, chatTurnId: 't1' });
    expect(result).toEqual({ ok: true, answers: { relevant: 'yes' }, model: 'served' });
    expect(createDecisionClient).toHaveBeenCalledWith(PROVIDER);
    expect(wrapDecide).toHaveBeenCalledWith(expect.any(Function), {
      provider: 'llama_decision',
      model: 'm',
    });
    expect(limit).toHaveBeenCalledWith(expect.any(Function), expect.any(AbortSignal), {
      providerKey: 'http://localhost:8080',
    });
    expect(decide).toHaveBeenCalledWith(
      'page',
      QUESTIONS,
      expect.objectContaining({ verboseLogs: true, signal: expect.any(AbortSignal) }),
    );
  });

  it('fails without a provider and for empty questions, without calling the client', async () => {
    const { service, createDecisionClient } = make({ provider: null });
    expect(await service.decide({ state: 's', questions: QUESTIONS })).toEqual({
      ok: false,
      error: 'No decision provider is selected for the project chat page scan.',
    });
    expect(createDecisionClient).not.toHaveBeenCalled();
    for (const questions of [undefined, {}, [], 'q']) {
      expect((await make().service.decide({ state: 's', questions })).ok).toBe(false);
    }
  });

  it('returns ok:false with the token scrubbed when the call fails', async () => {
    const { service } = make({
      decide: vi.fn(async () => {
        throw new Error('HTTP 401: bad key sekret');
      }),
    });
    const result = await service.decide({ state: 's', questions: QUESTIONS });
    expect(result).toEqual({ ok: false, error: 'HTTP 401: bad key [redacted]' });
    expect(result).not.toHaveProperty('answers');
  });

  it('fails when the response has no answers', async () => {
    const { service } = make({ decide: vi.fn(async () => ({})) });
    expect((await service.decide({ state: 's', questions: QUESTIONS })).ok).toBe(false);
  });

  it('retries a transient status and then succeeds', async () => {
    const decide = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('busy'), { status: 503 }))
      .mockResolvedValueOnce({ answers: { relevant: 'no' } });
    const { service, limit } = make({ decide });
    expect(await service.decide({ state: 's', questions: QUESTIONS })).toEqual({
      ok: true,
      answers: { relevant: 'no' },
    });
    expect(decide).toHaveBeenCalledTimes(2);
    // Every attempt takes its own limiter slot.
    expect(limit).toHaveBeenCalledTimes(2);
  });

  it('does not retry a permanent failure', async () => {
    const decide = vi.fn(async () => {
      throw Object.assign(new Error('nope'), { status: 400 });
    });
    const { service } = make({ decide });
    expect((await service.decide({ state: 's', questions: QUESTIONS })).ok).toBe(false);
    expect(decide).toHaveBeenCalledTimes(1);
  });

  it('cancelTurn aborts only that turn’s in-flight requests', async () => {
    const signals = {};
    const decide = vi.fn(
      (_state, _questions, { signal }) =>
        new Promise((_resolve, reject) => {
          signals[_state] = signal;
          signal.addEventListener('abort', () => reject(signal.reason));
        }),
    );
    const { service } = make({ decide });
    const first = service.decide({ state: 'a', questions: QUESTIONS, chatTurnId: 't1' });
    const second = service.decide({ state: 'b', questions: QUESTIONS, chatTurnId: 't2' });
    await vi.waitFor(() => expect(decide).toHaveBeenCalledTimes(2));

    service.cancelTurn('t1');
    expect(await first).toMatchObject({ ok: false, cancelled: true });
    expect(signals.a.aborted).toBe(true);
    expect(signals.b.aborted).toBe(false);

    service.cancelAll();
    expect(await second).toMatchObject({ ok: false, cancelled: true });
    // Cancelling a finished or unknown turn is a no-op.
    expect(() => service.cancelTurn('t1')).not.toThrow();
  });

  it.each([
    ['turn', 't1'],
    ['no turn', undefined],
  ])('tracks and cancels a request with %s during provider lookup', async (_label, chatTurnId) => {
    let releaseProvider;
    const getPageScanProvider = vi.fn(() => new Promise((resolve) => (releaseProvider = resolve)));
    const { service, createDecisionClient } = make({ getPageScanProvider });
    const pending = service.decide({ state: 's', questions: QUESTIONS, chatTurnId });
    const jobs = service.activeCompletionJobs();
    expect(jobs).toHaveLength(1);
    if (chatTurnId) service.cancelTurn(chatTurnId);
    else service.cancelAll();
    releaseProvider(PROVIDER);
    expect(await pending).toMatchObject({ ok: false, cancelled: true });
    await Promise.allSettled(jobs);
    expect(createDecisionClient).not.toHaveBeenCalled();
    expect(service.activeCompletionJobs()).toEqual([]);
  });

  it('tracks a no-turn request until its decision wrapper finishes', async () => {
    let release;
    const wrapDecide = () => () => new Promise((resolve) => (release = resolve));
    const { service } = make({ wrapDecide });
    const pending = service.decide({ state: 's', questions: QUESTIONS });
    await vi.waitFor(() => expect(release).toBeDefined());
    const jobs = service.activeCompletionJobs();
    expect(jobs).toHaveLength(1);
    release({ answers: { relevant: 'yes' } });
    await Promise.allSettled(jobs);
    await pending;
    expect(service.activeCompletionJobs()).toEqual([]);
  });

  it('keeps the worker alive only while a request is in flight', async () => {
    let release;
    const decide = vi.fn(() => new Promise((resolve) => (release = resolve)));
    const setIntervalFn = vi.fn(() => 42);
    const clearIntervalFn = vi.fn();
    const { service } = make({ decide, setIntervalFn, clearIntervalFn, keepAliveIntervalMs: 5 });
    const pending = service.decide({ state: 's', questions: QUESTIONS });
    await vi.waitFor(() => expect(decide).toHaveBeenCalled());
    expect(setIntervalFn).toHaveBeenCalledWith(expect.any(Function), 5);
    expect(clearIntervalFn).not.toHaveBeenCalled();
    release({ answers: { relevant: 'yes' } });
    await pending;
    expect(clearIntervalFn).toHaveBeenCalledWith(42);
  });
});
