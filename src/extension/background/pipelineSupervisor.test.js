// The point of these tests is what they *don't* set up: there is no `chrome`
// global, no `vi.mock` of the storage/orchestrator modules, and no import of
// background.js. If this file ever needs a chrome stub, the supervisor has
// re-acquired a hidden dependency on the browser and the extraction has
// regressed.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PIPELINE_STATUS } from '../../shared/runtime/contracts.js';
import { createPipelineSupervisor, KEEPALIVE_ALARM } from './pipelineSupervisor.js';

/** Silences the supervisor's console output without asserting on it. */
const silentLogger = () => {
  const logger = {
    prefix: '',
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    event: vi.fn(),
    child: () => logger,
  };
  return logger;
};

function makeAlarms({ existing = null, getError = null } = {}) {
  const runtime = { lastError: getError };
  const alarms = {
    get: vi.fn((_name, cb) => cb(existing)),
    create: vi.fn(() => undefined),
    clear: vi.fn(),
  };
  return { alarms, runtime };
}

function makeSupervisor(overrides = {}) {
  const { alarms, runtime } = overrides.alarmSetup || makeAlarms();
  const records = new Map(overrides.records || []);
  const recordRepository = {
    readRecord: vi.fn(async (key) => records.get(key) || null),
    listRecords: vi.fn(async () => [...records.values()]),
    updateRecord: vi.fn(async (key, patch) => {
      const rec = records.get(key);
      if (!rec) return null;
      const next = { ...rec, ...patch };
      records.set(key, next);
      return next;
    }),
  };
  const runPipeline = overrides.runPipeline || vi.fn(async () => {});
  let now = 1_000_000;
  const supervisor = createPipelineSupervisor({
    recordRepository,
    runPipeline,
    alarms,
    runtime,
    failureBreaker: overrides.failureBreaker,
    clock: () => now,
    idFactory: overrides.idFactory || (() => 'run-generated'),
    logger: silentLogger(),
  });
  return {
    supervisor,
    records,
    recordRepository,
    runPipeline,
    alarms,
    runtime,
    advance: (ms) => {
      now += ms;
    },
  };
}

/**
 * Kicks off a run without awaiting it. `startPipeline` resolves with the run
 * promise, so awaiting it would block on stubs that model a still-running
 * pipeline. Returns once the job is registered.
 *
 * @param {object} supervisor
 * @param {string} key
 * @param {import('vitest').Mock} runPipeline
 * @param {number} expectedCalls Run count to wait for.
 */
async function startWithoutAwaiting(supervisor, key, runPipeline, expectedCalls = 1) {
  const pending = supervisor.startPipeline(key);
  // The run promise is deliberately left pending; swallow the abort rejection
  // a later cancel/reset produces so it never surfaces as an unhandled one.
  Promise.resolve(pending).catch(() => {});
  await vi.waitFor(() => expect(runPipeline).toHaveBeenCalledTimes(expectedCalls));
}

describe('createPipelineSupervisor (no chrome global)', () => {
  beforeEach(() => {
    // Assert the premise rather than trusting it: a stray global from another
    // suite would silently invalidate every test below.
    expect(globalThis.chrome).toBeUndefined();
  });

  afterEach(() => {
    expect(globalThis.chrome).toBeUndefined();
  });

  it('constructs and runs a pipeline with only injected dependencies', async () => {
    const { supervisor, runPipeline } = makeSupervisor({
      records: [['k1', { key: 'k1', status: PIPELINE_STATUS.PENDING, pipelineRunId: 'run-1' }]],
    });

    await supervisor.startPipeline('k1');

    expect(runPipeline).toHaveBeenCalledTimes(1);
    expect(runPipeline.mock.calls[0][0]).toBe('k1');
    expect(runPipeline.mock.calls[0][1].pipelineRunId).toBe('run-1');
  });

  it('arms the keepalive alarm before reading the record', async () => {
    const order = [];
    const { alarms, runtime } = makeAlarms();
    alarms.get.mockImplementation((_name, cb) => {
      order.push('alarm');
      cb(null);
    });
    const { supervisor, recordRepository } = makeSupervisor({
      alarmSetup: { alarms, runtime },
      records: [['k1', { key: 'k1', status: PIPELINE_STATUS.PENDING, pipelineRunId: 'run-1' }]],
    });
    recordRepository.readRecord.mockImplementation(async () => {
      order.push('read');
      return { key: 'k1', status: PIPELINE_STATUS.PENDING, pipelineRunId: 'run-1' };
    });

    await supervisor.startPipeline('k1');

    expect(order).toEqual(['alarm', 'read']);
    expect(alarms.create).toHaveBeenCalledWith(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
  });

  it('does not start a pipeline for a record that is not in flight', async () => {
    const { supervisor, runPipeline } = makeSupervisor({
      records: [['done', { key: 'done', status: PIPELINE_STATUS.DONE, pipelineRunId: 'run-1' }]],
    });

    await supervisor.startPipeline('done');

    expect(runPipeline).not.toHaveBeenCalled();
  });

  it('does not restart a healthy in-flight job', async () => {
    const runPipeline = vi.fn(() => new Promise(() => {}));
    const { supervisor } = makeSupervisor({
      runPipeline,
      records: [
        [
          'k1',
          {
            key: 'k1',
            status: PIPELINE_STATUS.PENDING,
            pipelineRunId: 'run-1',
            updatedAt: 1_000_000,
          },
        ],
      ],
    });

    await startWithoutAwaiting(supervisor, 'k1', runPipeline);
    await startWithoutAwaiting(supervisor, 'k1', runPipeline);

    expect(runPipeline).toHaveBeenCalledTimes(1);
    expect(supervisor.isActive('k1')).toBe(true);
  });

  it('does not evict a registered job when its storage record is old', async () => {
    const runPipeline = vi.fn(() => new Promise(() => {}));
    const { supervisor, records, advance, recordRepository } = makeSupervisor({
      runPipeline,
      records: [
        [
          'k1',
          {
            key: 'k1',
            status: PIPELINE_STATUS.PENDING,
            pipelineRunId: 'run-1',
            updatedAt: 1_000_000,
          },
        ],
      ],
    });

    await startWithoutAwaiting(supervisor, 'k1', runPipeline);
    // Push the record past the old 10-minute stale threshold.
    advance(11 * 60 * 1000);
    await supervisor.startPipeline('k1');

    expect(recordRepository.updateRecord).not.toHaveBeenCalled();
    expect(records.get('k1').pipelineRunId).toBe('run-1');
    expect(runPipeline).toHaveBeenCalledTimes(1);
    expect(supervisor.isActive('k1')).toBe(true);
  });

  it('persists an ERROR status, guarded by run id, when the pipeline rejects', async () => {
    const runPipeline = vi.fn(async () => {
      throw new Error('boom');
    });
    const { supervisor, recordRepository } = makeSupervisor({
      runPipeline,
      records: [['k1', { key: 'k1', status: PIPELINE_STATUS.PENDING, pipelineRunId: 'run-1' }]],
    });

    await supervisor.startPipeline('k1');

    const [key, patch, options] = recordRepository.updateRecord.mock.calls.at(-1);
    expect(key).toBe('k1');
    expect(patch.status).toBe(PIPELINE_STATUS.ERROR);
    expect(options).toEqual({ expectedPipelineRunId: 'run-1' });
  });

  it('cancelActivePipeline refuses to abort a run it does not own', async () => {
    const runPipeline = vi.fn(() => new Promise(() => {}));
    const { supervisor } = makeSupervisor({
      runPipeline,
      records: [['k1', { key: 'k1', status: PIPELINE_STATUS.PENDING, pipelineRunId: 'run-1' }]],
    });
    await startWithoutAwaiting(supervisor, 'k1', runPipeline);

    expect(supervisor.cancelActivePipeline('k1', { expectedPipelineRunId: 'other' })).toBe(false);
    expect(supervisor.isActive('k1')).toBe(true);
    expect(supervisor.cancelActivePipeline('k1', { expectedPipelineRunId: 'run-1' })).toBe(true);
    expect(supervisor.isActive('k1')).toBe(false);
  });

  it('never clears the keepalive on cancel — only the alarm handler may', async () => {
    const runPipeline = vi.fn(() => new Promise(() => {}));
    const { supervisor, alarms } = makeSupervisor({
      runPipeline,
      records: [['k1', { key: 'k1', status: PIPELINE_STATUS.PENDING, pipelineRunId: 'run-1' }]],
    });
    await startWithoutAwaiting(supervisor, 'k1', runPipeline);

    // The in-memory registry is not the source of truth for whether work
    // remains: a cancelled run can leave an in-flight status in storage.
    supervisor.cancelActivePipeline('k1');
    expect(alarms.clear).not.toHaveBeenCalled();
    supervisor.cancelAll();
    expect(alarms.clear).not.toHaveBeenCalled();
  });

  it('the alarm handler clears the keepalive from storage truth', async () => {
    const { supervisor, alarms, records } = makeSupervisor({
      records: [['k1', { key: 'k1', status: PIPELINE_STATUS.DONE, pipelineRunId: 'run-1' }]],
    });

    supervisor.handleKeepAliveAlarm({ name: KEEPALIVE_ALARM });
    await vi.waitFor(() => expect(alarms.clear).toHaveBeenCalledWith(KEEPALIVE_ALARM));

    // ...and leaves it armed while a record is still in flight.
    alarms.clear.mockClear();
    records.set('k2', { key: 'k2', status: PIPELINE_STATUS.PENDING, pipelineRunId: 'run-2' });
    supervisor.handleKeepAliveAlarm({ name: KEEPALIVE_ALARM });
    await vi.waitFor(() => expect(supervisor.isActive('k2')).toBe(false));
    expect(alarms.clear).not.toHaveBeenCalled();
  });

  it('ignores alarms that are not the keepalive', () => {
    const { supervisor, recordRepository } = makeSupervisor();
    supervisor.handleKeepAliveAlarm({ name: 'some-other-alarm' });
    expect(recordRepository.listRecords).not.toHaveBeenCalled();
  });

  it('resumeInFlightRecords restarts every orphaned record', async () => {
    const { supervisor, runPipeline } = makeSupervisor({
      records: [
        ['a', { key: 'a', status: PIPELINE_STATUS.PENDING, pipelineRunId: 'run-a' }],
        ['b', { key: 'b', status: PIPELINE_STATUS.DONE, pipelineRunId: 'run-b' }],
        ['c', { key: 'c', status: PIPELINE_STATUS.SUMMARIZING, pipelineRunId: 'run-c' }],
      ],
    });

    await supervisor.resumeInFlightRecords();
    await vi.waitFor(() => expect(runPipeline).toHaveBeenCalledTimes(2));
    expect(runPipeline.mock.calls.map((call) => call[0]).sort()).toEqual(['a', 'c']);
  });

  it('resumeInFlightRecords survives a failing storage scan', async () => {
    const { supervisor, recordRepository, alarms } = makeSupervisor();
    recordRepository.listRecords.mockRejectedValue(new Error('storage down'));

    await expect(supervisor.resumeInFlightRecords()).resolves.toBeUndefined();
    expect(alarms.create).not.toHaveBeenCalled();
  });

  it('fails closed before provider work when an automatic resume cannot claim storage', async () => {
    const failures = new Map();
    const failureBreaker = {
      getAll: vi.fn(async () => Object.fromEntries(failures)),
      recordFailure: vi.fn(async ({ pipelineRunId }) => {
        const state = { pipelineRunId, failures: 1, open: false };
        failures.set(pipelineRunId, state);
        return state;
      }),
      clear: vi.fn(async () => {}),
      clearForKey: vi.fn(async () => {}),
    };
    const { supervisor, recordRepository, runPipeline } = makeSupervisor({
      failureBreaker,
      records: [['k1', { key: 'k1', status: PIPELINE_STATUS.PENDING, pipelineRunId: 'run-1' }]],
    });
    recordRepository.updateRecord.mockRejectedValue(new Error('disk full'));

    await supervisor.startPipeline('k1', { automatic: true });

    expect(runPipeline).not.toHaveBeenCalled();
    expect(failureBreaker.recordFailure).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'k1', pipelineRunId: 'run-1' }),
    );
  });

  it('records a breaker failure when the fallback ERROR write also fails', async () => {
    const failureBreaker = {
      getAll: vi.fn(async () => ({})),
      recordFailure: vi.fn(async () => ({ failures: 1, open: false })),
      clear: vi.fn(async () => {}),
      clearForKey: vi.fn(async () => {}),
    };
    const runPipeline = vi.fn(async () => {
      throw new Error('provider failed');
    });
    const { supervisor, recordRepository } = makeSupervisor({
      failureBreaker,
      runPipeline,
      records: [['k1', { key: 'k1', status: PIPELINE_STATUS.PENDING, pipelineRunId: 'run-1' }]],
    });
    recordRepository.updateRecord.mockRejectedValue(new Error('disk full'));

    await supervisor.startPipeline('k1');

    expect(failureBreaker.recordFailure).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'k1', pipelineRunId: 'run-1' }),
    );
  });

  it('skips an open run breaker and exposes separate runtime failure metadata', async () => {
    const state = {
      pipelineRunId: 'run-1',
      failures: 3,
      open: true,
      message: 'Storage unavailable; automatic processing paused.',
    };
    const failureBreaker = {
      getAll: vi.fn(async () => ({ 'run-1': state })),
      recordFailure: vi.fn(),
      clear: vi.fn(),
      clearForKey: vi.fn(),
    };
    const record = { key: 'k1', status: PIPELINE_STATUS.PENDING, pipelineRunId: 'run-1' };
    const { supervisor, runPipeline, alarms } = makeSupervisor({
      failureBreaker,
      records: [['k1', record]],
    });

    await supervisor.startPipeline('k1', { automatic: true });
    expect(runPipeline).not.toHaveBeenCalled();

    const runtimeState = await supervisor.getPipelineFailures([record]);
    expect(runtimeState).toEqual({
      failures: {
        k1: {
          kind: 'storage_unavailable',
          message: state.message,
          retryable: true,
          pipelineRunId: 'run-1',
        },
      },
      unavailable: false,
    });

    supervisor.handleKeepAliveAlarm({ name: KEEPALIVE_ALARM });
    await vi.waitFor(() => expect(alarms.clear).toHaveBeenCalledWith(KEEPALIVE_ALARM));
  });

  it('leaves the keepalive armed when the breaker snapshot read fails transiently', async () => {
    const failureBreaker = {
      getAll: vi.fn(async () => {
        throw new Error('session backend busy');
      }),
      recordFailure: vi.fn(),
      clear: vi.fn(),
      clearForKey: vi.fn(),
    };
    const { supervisor, runPipeline, alarms } = makeSupervisor({
      failureBreaker,
      records: [['k1', { key: 'k1', status: PIPELINE_STATUS.PENDING, pipelineRunId: 'run-1' }]],
    });

    supervisor.handleKeepAliveAlarm({ name: KEEPALIVE_ALARM });
    await vi.waitFor(() => expect(failureBreaker.getAll).toHaveBeenCalled());

    expect(runPipeline).not.toHaveBeenCalled();
    expect(alarms.clear).not.toHaveBeenCalled();
  });

  it('keeps its keepalive throttle out of sibling supervisors', () => {
    // Two supervisors over the same alarms namespace: the first one's create
    // must not suppress the second's, or a fresh supervisor could come up with
    // no keepalive at all.
    const { alarms, runtime } = makeAlarms();
    const build = () =>
      createPipelineSupervisor({
        recordRepository: {
          readRecord: vi.fn(),
          listRecords: vi.fn(),
          updateRecord: vi.fn(),
        },
        runPipeline: vi.fn(),
        alarms,
        runtime,
        logger: silentLogger(),
      });

    build().scheduleKeepAlive();
    build().scheduleKeepAlive();

    expect(alarms.create).toHaveBeenCalledTimes(2);
  });

  it('reset aborts in-flight runs and empties the registry', async () => {
    let signal;
    const runPipeline = vi.fn(
      (_key, options) =>
        new Promise(() => {
          signal = options.signal;
        }),
    );
    const { supervisor } = makeSupervisor({
      runPipeline,
      records: [['k1', { key: 'k1', status: PIPELINE_STATUS.PENDING, pipelineRunId: 'run-1' }]],
    });
    await startWithoutAwaiting(supervisor, 'k1', runPipeline);

    supervisor.reset();

    expect(signal.aborted).toBe(true);
    expect(supervisor.isActive('k1')).toBe(false);
    expect(supervisor.activeJobPromises()).toEqual([]);
  });
});
