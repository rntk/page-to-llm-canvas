import { describe, it, expect, vi, afterEach } from 'vitest';
import { createCheckpointer } from './summaryTreeCheckpoint.js';
import { SUMMARY_TREE_STAGE, SUMMARY_TREE_STATUS } from '../../shared/runtime/summaryTree.js';

const makeInput = (overrides = {}) => {
  const nodes = {
    p1: { kind: 'passage', segments: [{ text: 'done' }], failed: false },
    p2: { kind: 'passage', segments: null, failed: true },
    p3: { kind: 'passage', segments: [], failed: false },
    t1: { kind: 'topic', segments: null, children: ['p1'] },
    root: { kind: 'root', segments: null, children: ['t1'] },
  };
  const saves = [];
  const runtime = { saveSummaryTree: vi.fn(async (tree) => saves.push(tree)), log: vi.fn(async () => {}) };
  const args = {
    runtime, now: () => Date.now(), nodes, getRootId: () => 'root',
    strategy: { contentRevision: 'rev' }, fingerprint: 'fp', startedAt: 1,
    llm: { metrics: { calls: 4, invalidAnswers: 2, failures: 1 } },
    judge: { metrics: { calls: 3, failures: 1 }, active: true },
    verifier: { metrics: { dropped: 5 } }, heartbeatMs: 0,
    controller: new AbortController(),
    ...overrides,
  };
  return { args, saves, runtime };
};

afterEach(() => vi.useRealTimers());

describe('summary tree checkpointer', () => {
  it('throttles saves and flushes the skipped snapshot', async () => {
    let time = 1000;
    const { args, saves } = makeInput({ now: () => time });
    const cp = createCheckpointer(args);
    await cp.save();
    time += 500;
    await cp.save();
    expect(cp.unsaved).toBe(true);
    expect(saves).toHaveLength(1);
    await cp.flush();
    expect(saves).toHaveLength(2);
    expect(cp.unsaved).toBe(false);
    cp.dispose();
  });

  it('aborts on heartbeat save rejection and clears its timer on dispose', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const controller = new AbortController();
    const failure = new Error('lost ownership');
    const saveSummaryTree = vi.fn().mockRejectedValue(failure);
    const { args } = makeInput({
      runtime: { saveSummaryTree, log: vi.fn(async () => {}) }, heartbeatMs: 10, controller,
    });
    const cp = createCheckpointer(args);
    await vi.advanceTimersByTimeAsync(10);
    expect(controller.signal.reason).toBe(failure);
    cp.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(args.runtime.saveSummaryTree).toHaveBeenCalledTimes(1);
  });

  it('reports progress and metrics for each stage, including failed and skipped passages and root', async () => {
    const { args, saves } = makeInput();
    const cp = createCheckpointer(args);
    await cp.save();
    expect(saves[0]).toMatchObject({
      progress: { done: 2, total: 3 },
      metrics: { passages: 3, failedPassages: 1, skippedPassages: 1, topics: 1, llmCalls: 4,
        llmInvalidAnswers: 2, llmFailures: 1, decisionCalls: 3, decisionFailures: 1,
        decisionsActive: true, claimsDropped: 5 },
    });
    await cp.enterStage(SUMMARY_TREE_STAGE.TOPICS);
    expect(saves.at(-1).progress).toEqual({ done: 1, total: 0 });
    args.nodes.t1.segments = [];
    await cp.enterStage(SUMMARY_TREE_STAGE.SUMMARIES);
    expect(saves.at(-1).progress).toEqual({ done: 1, total: 2 });
    args.nodes.root.segments = [];
    expect(cp.finish()).toMatchObject({
      status: SUMMARY_TREE_STATUS.DONE, progress: { done: 2, total: 2 },
    });
    cp.dispose();
  });
});
