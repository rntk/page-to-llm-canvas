import { describe, expect, it, vi } from 'vitest';
import {
  createPipelineFailureBreaker,
  PIPELINE_FAILURE_BREAKER_KEY,
} from './pipelineFailureBreaker.js';

function makeSessionArea() {
  const store = new Map();
  return {
    store,
    area: {
      get: vi.fn((key, callback) => callback(store.has(key) ? { [key]: store.get(key) } : {})),
      set: vi.fn((items, callback) => {
        for (const [key, value] of Object.entries(items)) store.set(key, value);
        callback();
      }),
    },
  };
}

describe('pipeline failure breaker', () => {
  it('survives supervisor/service-worker reconstruction through session storage', async () => {
    const { area, store } = makeSessionArea();
    const deps = { getStorageArea: () => area, runtime: { lastError: null }, threshold: 3 };
    const firstWorker = createPipelineFailureBreaker(deps);

    await firstWorker.recordFailure({ key: 'k1', pipelineRunId: 'run-1', error: new Error('one') });
    await firstWorker.recordFailure({ key: 'k1', pipelineRunId: 'run-1', error: new Error('two') });

    const nextWorker = createPipelineFailureBreaker(deps);
    const opened = await nextWorker.recordFailure({
      key: 'k1',
      pipelineRunId: 'run-1',
      error: new Error('three'),
    });

    expect(opened).toMatchObject({ failures: 3, open: true });
    expect((await nextWorker.get('run-1')).open).toBe(true);
    expect(store.has(PIPELINE_FAILURE_BREAKER_KEY)).toBe(true);
  });

  it('clears only the requested run', async () => {
    const { area } = makeSessionArea();
    const breaker = createPipelineFailureBreaker({
      getStorageArea: () => area,
      runtime: { lastError: null },
      threshold: 1,
    });
    await breaker.recordFailure({ key: 'a', pipelineRunId: 'run-a', error: new Error('x') });
    await breaker.recordFailure({ key: 'b', pipelineRunId: 'run-b', error: new Error('x') });

    await breaker.clear('run-a');

    expect(await breaker.get('run-a')).toBeNull();
    expect((await breaker.get('run-b')).open).toBe(true);
  });

  it('never evicts open breakers when the soft entry cap is exceeded', async () => {
    const { area } = makeSessionArea();
    let now = 0;
    const breaker = createPipelineFailureBreaker({
      getStorageArea: () => area,
      runtime: { lastError: null },
      threshold: 1,
      clock: () => ++now,
    });

    for (let index = 0; index < 101; index++) {
      await breaker.recordFailure({
        key: `key-${index}`,
        pipelineRunId: `run-${index}`,
        error: new Error('storage down'),
      });
    }

    expect((await breaker.get('run-0')).open).toBe(true);
    expect(Object.keys(await breaker.getAll())).toHaveLength(101);
  });

  it('clears obsolete runs for one record without touching other records', async () => {
    const { area } = makeSessionArea();
    const breaker = createPipelineFailureBreaker({
      getStorageArea: () => area,
      runtime: { lastError: null },
      threshold: 1,
    });
    await breaker.recordFailure({ key: 'a', pipelineRunId: 'run-a-old', error: new Error('x') });
    await breaker.recordFailure({ key: 'a', pipelineRunId: 'run-a-new', error: new Error('x') });
    await breaker.recordFailure({ key: 'b', pipelineRunId: 'run-b', error: new Error('x') });

    await breaker.clearForKey('a', 'run-a-new');

    expect(await breaker.get('run-a-old')).toBeNull();
    expect((await breaker.get('run-a-new')).open).toBe(true);
    expect((await breaker.get('run-b')).open).toBe(true);
  });
});
