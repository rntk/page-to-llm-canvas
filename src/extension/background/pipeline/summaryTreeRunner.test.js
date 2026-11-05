import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createPipelineRunner } from './orchestrator.js';
import { createPipelineRuntime } from './pipelineRuntime.js';
import * as storage from '../../../core/storage/storage.js';
import { createSummaryTreeJobs } from '../summaryTreeJobs.js';
import { createRecordHandlers } from '../handlers/recordHandlers.js';
import { MSG } from '../../../shared/runtime/messages.js';

vi.mock('../../../core/storage/storage.js', () => ({
  SOURCE_SUMMARY_UNIT_REVISION_MISMATCH: Object.freeze({ reason: 'content_revision_mismatch' }),
  readRecord: vi.fn(),
  updateRecord: vi.fn(),
  putTopicSummaryCheckpoint: vi.fn(),
  putSourceSummaryUnit: vi.fn(),
  appendProcessingLog: vi.fn(async () => {}),
  flushProcessingLog: vi.fn(async () => {}),
}));

const limiter = { run: vi.fn((fn) => fn()), setLimit: vi.fn() };

function passageAnswer(prompt) {
  const first = /"evidence":"(\d+)\|/u.exec(prompt)?.[1];
  if (first) {
    return JSON.stringify({
      summaries: [{ id: 'item', title: `S${first}`, segments: [{ text: 'Fact.', from: [first] }] }],
    });
  }
  return JSON.stringify({
    summaries: [{ id: 'item', segments: [{ text: 'Overview.', from: ['C1.S1'] }] }],
  });
}

function makeRunner({
  callLLMWithRetry = vi.fn(async ({ prompt }) => passageAnswer(prompt)),
} = {}) {
  const runner = createPipelineRunner({
    runtimeFactory: createPipelineRuntime,
    settings: {
      getPreferContentLanguage: vi.fn(async () => false),
      getVerboseLogs: vi.fn(async () => false),
      getMaxParallelLlmRequests: vi.fn(async () => 4),
      getDecisionSplitThreshold: vi.fn(async () => 0.5),
      normalizeMaxParallelLlmRequests: (value) => value,
      subscribeToMaxParallelLlmRequests: vi.fn(() => () => {}),
    },
    providerRepository: {
      getActiveProvider: vi.fn(async () => ({ id: 'p', type: 'openai', model: 'm' })),
      getDecisionProvider: vi.fn(async () => null),
    },
    llm: { callLLMWithRetry, createDecisionClient: vi.fn() },
    limiterFactory: () => limiter,
    telemetry: { wrapCallLLMWithRetry: (fn) => fn, wrapDecide: (fn) => fn },
    logger: { info: vi.fn(), error: vi.fn() },
  });
  return { runner, callLLMWithRetry };
}

// Two short sentences form one passage, so the root summarizes it directly.
const doneRecord = () => ({
  key: 'k',
  status: 'done',
  pipelineRunId: 'run-1',
  contentRevision: 'rev',
  sourceUrl: 'https://example.com/a',
  sentences: ['Apples are red.', 'Pears are green.'],
  topics: [{ name: 'Fruit', sentences: [1, 2] }],
});

let stored;
beforeEach(() => {
  vi.clearAllMocks();
  stored = doneRecord();
  storage.readRecord.mockImplementation(async () => stored && { ...stored });
  storage.updateRecord.mockImplementation(async (key, patch, options) => {
    if (options.expectedPipelineRunId !== stored.pipelineRunId) return null;
    if (options.expectedStatuses && !options.expectedStatuses.includes(stored.status)) return null;
    stored = { ...stored, ...patch };
    return stored;
  });
});

describe('runSummaryTree', () => {
  it('saves the tree beside a completed record owned by its run', async () => {
    const { runner } = makeRunner();
    await runner.runSummaryTree('k');
    expect(stored.status).toBe('done');
    expect(stored.summary_tree).toMatchObject({ status: 'done', contentRevision: 'rev' });
    const root = stored.summary_tree.nodes[stored.summary_tree.rootId];
    expect(root).toMatchObject({ kind: 'root', title: 'example.com' });
    // A single child is relayed rather than summarized again.
    expect(root.segments).toEqual([
      { text: 'Fact.', sources: [{ kind: 'claim', child: root.children[0], segment: 0 }] },
    ]);
    for (const [, , options] of storage.updateRecord.mock.calls) {
      expect(options).toEqual({ expectedPipelineRunId: 'run-1', expectedStatuses: ['done'] });
    }
  });

  it('requires a completed record', async () => {
    stored.status = 'summarizing';
    const { runner } = makeRunner();
    await expect(runner.runSummaryTree('k')).rejects.toThrow('must finish processing');
    expect(storage.updateRecord).not.toHaveBeenCalled();
  });

  it('records a stop on the saved partial tree', async () => {
    const controller = new AbortController();
    const callLLMWithRetry = vi.fn(async () => {
      controller.abort();
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });
    const { runner } = makeRunner({ callLLMWithRetry });
    await runner.runSummaryTree('k', { signal: controller.signal });
    expect(stored.summary_tree).toMatchObject({ status: 'cancelled', error: 'Stopped.' });
    expect(Object.keys(stored.summary_tree.nodes)).toHaveLength(1);
  });

  it('stores provider failures on the tree, not the record', async () => {
    const callLLMWithRetry = vi.fn(async () => {
      throw Object.assign(new Error('bad key'), { status: 401 });
    });
    const { runner } = makeRunner({ callLLMWithRetry });
    await runner.runSummaryTree('k');
    expect(stored.status).toBe('done');
    expect(stored.summary_tree).toMatchObject({ status: 'error', error: 'bad key' });
  });

  it('stops quietly when a newer run takes the record over', async () => {
    const callLLMWithRetry = vi.fn(async ({ prompt }) => {
      stored = { ...stored, pipelineRunId: 'run-2', status: 'pending' };
      return passageAnswer(prompt);
    });
    const { runner } = makeRunner({ callLLMWithRetry });
    await runner.runSummaryTree('k');
    expect(stored.pipelineRunId).toBe('run-2');
    expect(stored.summary_tree?.status).not.toBe('error');
  });
});

describe('summary tree jobs and handlers', () => {
  it('runs one build per record and stops it on request', async () => {
    let release;
    const runSummaryTree = vi.fn(
      (_key, { signal }) =>
        new Promise((resolve) => {
          release = resolve;
          signal.addEventListener('abort', () => resolve());
        }),
    );
    const jobs = createSummaryTreeJobs({ runSummaryTree, logger: { error: vi.fn() } });
    expect(jobs.start('k', { fresh: true })).toBe(true);
    expect(jobs.start('k')).toBe(false);
    await Promise.resolve();
    expect(runSummaryTree).toHaveBeenCalledWith('k', expect.objectContaining({ fresh: true }));
    expect(jobs.stop('k')).toBe(true);
    release();
    await vi.waitFor(() => expect(jobs.isActive('k')).toBe(false));
    expect(jobs.stop('k')).toBe(false);
  });

  it('starts builds only for completed records with a current checkpoint', async () => {
    const summaryTreeJobs = { start: vi.fn(() => true), stop: vi.fn(() => false) };
    const summaryCheckpoint = {
      isComplete: vi.fn(() => true),
      isRevisionCurrent: vi.fn(() => true),
    };
    const handlers = createRecordHandlers({
      recordRepository: { readRecord: storage.readRecord },
      handleSubmit: vi.fn(),
      pipelineSupervisor: {},
      getStoredSummariesDisabled: vi.fn(),
      summaryCheckpoint,
      summaryTreeJobs,
      logger: { child: () => ({ error: vi.fn() }) },
    });
    const build = (msg) => handlers[MSG.buildSummaryTree].handle({ key: 'k', ...msg });
    await expect(build({ fresh: true })).resolves.toEqual({ ok: true });
    expect(summaryTreeJobs.start).toHaveBeenCalledWith('k', { fresh: true });

    summaryTreeJobs.start.mockReturnValue(false);
    await expect(build({})).resolves.toEqual({ ok: true, stale: true });

    summaryCheckpoint.isRevisionCurrent.mockReturnValue(false);
    await expect(build({})).resolves.toMatchObject({ ok: false });
    stored.status = 'pending';
    await expect(build({})).resolves.toMatchObject({ ok: false, error: /not complete/ });

    await expect(handlers[MSG.stopSummaryTree].handle({ key: 'k' })).resolves.toEqual({
      ok: true,
      stale: true,
    });
  });
});
