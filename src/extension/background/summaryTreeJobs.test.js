import { describe, expect, it, vi } from 'vitest';
import { createSummaryTreeJobs } from './summaryTreeJobs.js';
import { createPipelineFailureBreaker } from './pipelineFailureBreaker.js';

function fixture() {
  const saved = new Map();
  const alarms = {
    get: vi.fn((_name, callback) => callback(null)),
    create: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
  };
  const runs = [];
  const makeJobs = () =>
    createSummaryTreeJobs({
      alarms,
      alarmName: 'tree-recovery',
      logger: { error: vi.fn() },
      prepareRun: async (key, { fresh }) => {
        saved.set(key, { ...(!fresh ? saved.get(key) : {}), status: 'running' });
      },
      listRunningKeys: async () =>
        [...saved].filter(([, tree]) => tree.status === 'running').map(([key]) => key),
      runSummaryTree: (key, { signal, fresh }) =>
        new Promise((resolve) => {
          runs.push({
            key,
            signal,
            fresh,
            finish: () => {
              saved.set(key, { ...saved.get(key), status: 'done' });
              resolve();
            },
          });
        }),
    });
  return { saved, alarms, runs, makeJobs };
}

describe('durable summary tree jobs', () => {
  it('does not revive a cancelled orphan from a recovery scan that finished late', async () => {
    let status = 'running';
    let releaseScan;
    const runSummaryTree = vi.fn(async () => {});
    const jobs = createSummaryTreeJobs({
      runSummaryTree,
      logger: { error: vi.fn() },
      listRunningKeys: () =>
        new Promise((resolve) => {
          releaseScan = resolve;
        }),
      canRecover: async () => status === 'running',
      onStop: async () => {
        status = 'cancelled';
        return true;
      },
    });
    const recovery = jobs.resumeInFlight();
    expect(await jobs.stop('k')).toBe(true);
    releaseScan(['k']);
    await recovery;
    expect(status).toBe('cancelled');
    expect(runSummaryTree).not.toHaveBeenCalled();
  });

  it('persists admission and arms recovery before acknowledging background work', async () => {
    const { saved, alarms, runs, makeJobs } = fixture();
    const jobs = makeJobs();
    expect(await jobs.start('article')).toBe(true);
    expect(saved.get('article').status).toBe('running');
    expect(alarms.create).toHaveBeenCalledWith('tree-recovery', { periodInMinutes: 0.5 });
    expect(runs[0].signal.aborted).toBe(false);
    expect(await jobs.start('article')).toBe(false);
    // No reader connection is involved in completing and saving the result.
    runs[0].finish();
    await vi.waitFor(() => expect(jobs.isActive('article')).toBe(false));
    expect(saved.get('article').status).toBe('done');
    await jobs.resumeInFlight();
    expect(alarms.clear).toHaveBeenCalledWith('tree-recovery');
  });

  it('starts a new run immediately after stop once the aborted run settles', async () => {
    const { runs, makeJobs } = fixture();
    const jobs = makeJobs();
    expect(await jobs.start('article')).toBe(true);
    await jobs.stop('article');
    expect(runs[0].signal.aborted).toBe(true);
    expect(jobs.isActive('article')).toBe(true);
    const restart = jobs.start('article');
    await Promise.resolve();
    expect(runs).toHaveLength(1);
    runs[0].finish();
    expect(await restart).toBe(true);
    expect(runs).toHaveLength(2);
    expect(runs[1].signal.aborted).toBe(false);
    expect(jobs.isActive('article')).toBe(true);
  });

  it('recovers a checkpoint after worker replacement without clearing completed work', async () => {
    const { saved, runs, makeJobs } = fixture();
    saved.set('project', { status: 'running', nodes: { passage: { text: 'Saved summary' } } });
    saved.set('stopped', { status: 'cancelled' });
    saved.set('complete', { status: 'done' });
    const restartedWorker = makeJobs();
    await restartedWorker.resumeInFlight();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ key: 'project', fresh: false });
    expect(saved.get('project').nodes.passage.text).toBe('Saved summary');
    await restartedWorker.resumeInFlight();
    expect(runs).toHaveLength(1);
    runs[0].finish();
  });

  it('retries recovery on its alarm and ignores unrelated alarms', async () => {
    const { saved, runs, makeJobs } = fixture();
    saved.set('project', { status: 'running' });
    const jobs = makeJobs();
    jobs.handleKeepAliveAlarm({ name: 'other' });
    expect(runs).toHaveLength(0);
    jobs.handleKeepAliveAlarm({ name: 'tree-recovery' });
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    runs[0].finish();
  });

  it('rejects a start when durable admission fails and releases ownership for retry', async () => {
    const prepareRun = vi
      .fn()
      .mockRejectedValueOnce(new Error('Storage unavailable'))
      .mockResolvedValue(undefined);
    const runSummaryTree = vi.fn(async () => {});
    const jobs = createSummaryTreeJobs({ prepareRun, runSummaryTree, logger: { error: vi.fn() } });
    await expect(jobs.start('k')).rejects.toThrow('Storage unavailable');
    expect(runSummaryTree).not.toHaveBeenCalled();
    expect(await jobs.start('k')).toBe(true);
  });

  it('stops automatic recovery after repeated runs that never leave RUNNING', async () => {
    const alarms = {
      get: vi.fn((_name, callback) => callback({})),
      create: vi.fn(async () => {}),
      clear: vi.fn(async () => {}),
    };
    // The terminal write keeps failing, so every run ends with the tree still running.
    const runSummaryTree = vi.fn(async () => {});
    const failureBreaker = createPipelineFailureBreaker({ getStorageArea: () => null });
    const jobs = createSummaryTreeJobs({
      runSummaryTree,
      logger: { error: vi.fn() },
      alarms,
      alarmName: 'tree-recovery',
      failureBreaker,
      listRunningKeys: async () => ['k'],
      canRecover: async () => true,
    });
    for (let tick = 1; tick <= 3; tick++) {
      await jobs.resumeInFlight();
      await vi.waitFor(() => expect(jobs.isActive('k')).toBe(false));
      expect(runSummaryTree).toHaveBeenCalledTimes(tick);
    }
    await jobs.resumeInFlight();
    expect(runSummaryTree).toHaveBeenCalledTimes(3);
    expect(alarms.clear).toHaveBeenCalledWith('tree-recovery');
    // An explicit start resets the breaker, like a user pipeline retry.
    expect(await jobs.start('k')).toBe(true);
    expect(runSummaryTree).toHaveBeenCalledTimes(4);
  });

  it('fails recovery closed when the checkpoint cannot be claimed', async () => {
    const runSummaryTree = vi.fn(async () => {});
    const failureBreaker = createPipelineFailureBreaker({ getStorageArea: () => null });
    const jobs = createSummaryTreeJobs({
      runSummaryTree,
      logger: { error: vi.fn() },
      failureBreaker,
      alarmName: 'tree-recovery',
      listRunningKeys: async () => ['k'],
      prepareRun: vi.fn().mockRejectedValue(new Error('Storage unavailable')),
    });
    await jobs.resumeInFlight();
    expect(runSummaryTree).not.toHaveBeenCalled();
    expect((await failureBreaker.get('tree-recovery:k'))?.failures).toBe(1);
  });

  it('skips recovery while the breaker cannot be read', async () => {
    const runSummaryTree = vi.fn(async () => {});
    const jobs = createSummaryTreeJobs({
      runSummaryTree,
      logger: { error: vi.fn() },
      failureBreaker: {
        getAll: vi.fn().mockRejectedValue(new Error('session unavailable')),
        recordFailure: vi.fn(),
        clear: vi.fn(),
      },
      listRunningKeys: async () => ['k'],
    });
    await jobs.resumeInFlight();
    expect(runSummaryTree).not.toHaveBeenCalled();
  });
});
