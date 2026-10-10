import { describe, it, expect, vi } from 'vitest';
import { executeDecisionStage } from './decisionStageExecution.js';
import { parallelMap } from '../llm/concurrency.js';
import { makeRuntime } from '../../../test/fakes/pipelineFixtures.mjs';

describe('decision stage cancellation', () => {
  it('aborts and drains sibling work while preserving the initiating failure and parent signal', async () => {
    const parent = new AbortController();
    const error = new Error('invalid answer');
    let siblingDrained = false;
    const workers = vi.fn(async (item, signal) => {
      if (item === 0) throw error;
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      await Promise.resolve();
      siblingDrained = true;
      signal.throwIfAborted();
    });
    await expect(
      executeDecisionStage(makeRuntime({ signal: parent.signal }), parallelMap, (runtime, map) =>
        map([0, 1, 2, 3, 4], 2, (item) => workers(item, runtime.signal)),
      ),
    ).rejects.toBe(error);
    expect(parent.signal.aborted).toBe(false);
    expect(siblingDrained).toBe(true);
    expect(workers).toHaveBeenCalledTimes(2);
  });
});
