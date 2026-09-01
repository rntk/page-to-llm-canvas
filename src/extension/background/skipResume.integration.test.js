// End-to-end cover for the "skip" resolution: the resolveSummaryErrors handler
// (which rewrites the failed leaf's error flags) and the real pipeline run it
// starts, wired to real storage over a chrome mock. Only the provider boundary
// is faked — a test that constructs the resumed summaries by hand bypasses
// `clearSummaryErrorFlags` and cannot catch a marker that never reaches the
// summary stage.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readRecord, writeRecord } from '../../../worker/storage/storage.js';
import { planSummaryWork } from '../../../worker/pipeline/summaryPlanning.js';
import * as llm from '../../../worker/llm/llm.js';

vi.mock('../../../worker/llm/llm.js', () => ({
  callLLMWithRetry: vi.fn(),
  // Unused by the pipeline path under test, but the worker's composition root
  // names every dependency when it builds the chat completion service, so the
  // mock has to carry it.
  callLLMDirect: vi.fn(),
}));

vi.mock('../../../worker/llm/concurrency.js', () => ({
  createAdjustableLimiter: vi.fn(() => ({ run: vi.fn((fn) => fn()), setLimit: vi.fn() })),
  createLimiter: vi.fn(() => (fn) => fn()),
  parallelMap: vi.fn(async (items, limit, fn) => {
    const results = [];
    for (let i = 0; i < items.length; i++) results.push(await fn(items[i], i));
    return results;
  }),
}));

function makeChromeMock() {
  const store = new Map();
  const runtime = { lastError: null };
  const local = {
    _store: store,
    getKeys: vi.fn((cb) => cb([...store.keys()])),
    get: vi.fn((keys, cb) => {
      runtime.lastError = null;
      const keyList =
        keys === null || keys === undefined
          ? [...store.keys()]
          : Array.isArray(keys)
            ? keys
            : [keys];
      const result = {};
      for (const k of keyList) if (store.has(k)) result[k] = store.get(k);
      cb(result);
    }),
    set: vi.fn((items, cb) => {
      runtime.lastError = null;
      for (const [k, v] of Object.entries(items)) store.set(k, v);
      cb();
    }),
    remove: vi.fn((keys, cb) => {
      runtime.lastError = null;
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
      cb();
    }),
    clear: vi.fn((cb) => {
      runtime.lastError = null;
      store.clear();
      cb();
    }),
  };
  return {
    storage: { local, onChanged: { addListener: vi.fn(), removeListener: vi.fn() } },
    runtime: {
      ...runtime,
      getURL: vi.fn((path = '') => `chrome-extension://test-id/${path}`),
      sendMessage: vi.fn(),
      onMessage: { addListener: vi.fn() },
      onStartup: { addListener: vi.fn() },
      onInstalled: { addListener: vi.fn() },
    },
    alarms: {
      create: vi.fn(),
      clear: vi.fn(),
      get: vi.fn((_name, cb) => cb(undefined)),
      onAlarm: { addListener: vi.fn() },
    },
    action: { setBadgeText: vi.fn(), setBadgeBackgroundColor: vi.fn(), setIcon: vi.fn() },
  };
}

// Long sentences ensure a normal parent merge would need the provider. Skip
// must still reach DONE without making that call.
const long = (marker) => `${marker} ${'word '.repeat(40)}`.trim();
const SENTENCES = [
  long('s1'),
  long('s2'),
  long('s3'),
  long('s4'),
  long('gap5'),
  long('gap6'),
  long('gap7'),
  long('gap8'),
  long('gap9'),
  long('zzz10'),
  long('zzz11'),
];

const TOPICS = [
  { name: 'A>x', sentences: [1, 2] },
  { name: 'A>y', sentences: [3, 4] },
  { name: 'A>z', sentences: [10, 11] },
];

function makeParkedRecord(key) {
  return {
    key,
    sourceUrl: 'https://example.com',
    html: '<p>parked</p>',
    text: SENTENCES.join(' '),
    contentRevision: 'checkpoint-revision',
    summaryCheckpointContentRevision: 'checkpoint-revision',
    status: 'needs_attention',
    error: null,
    progress: { stage: 'needs_attention', done: 2, total: 3 },
    sentences: SENTENCES,
    topics: TOPICS,
    summaryErrors: [{ topic: 'A>z', error_kind: 'timeout', error_message: 'The model timed out.' }],
    topic_summaries: {
      'A>x': { runs: [{ sentences: [1, 2], text: 'LEAF x' }], source_sentences: [1, 2] },
      'A>y': { runs: [{ sentences: [3, 4], text: 'LEAF y' }], source_sentences: [3, 4] },
      'A>z': {
        runs: [{ sentences: [10, 11], text: '' }],
        source_sentences: [10, 11],
        error: true,
        error_kind: 'timeout',
        error_message: 'The model timed out.',
        error_detail: 'timed out',
      },
    },
    topic_summary_index: {},
    processingLog: [],
    createdAt: 1000,
    updatedAt: 1000,
  };
}

describe('resolveSummaryErrors skip → resumed pipeline', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('finalizes the skipped leaf while preserving unaffected parent work', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);
    await writeRecord(makeParkedRecord('skipflow'));

    llm.callLLMWithRetry.mockResolvedValue('UNAFFECTED PARENT');

    const { dispatchMessage, _resetJobRegistry } = await import('./background.js');
    _resetJobRegistry();

    const res = await dispatchMessage(
      { type: 'resolveSummaryErrors', key: 'skipflow', action: 'skip' },
      {},
    );
    expect(res.ok).toBe(true);

    await vi.waitFor(async () => {
      expect((await readRecord('skipflow')).status).toBe('done');
    });
    const done = await readRecord('skipflow');

    // (a) The failed leaf's source is skipped. A separate parent run built only
    // from successful leaves still goes through the provider and is preserved.
    expect(done.topic_summary_index.A.runs).toEqual([
      { sentences: [1, 2, 3, 4], text: 'UNAFFECTED PARENT' },
      { sentences: [10, 11], text: '' },
    ]);
    expect(done.topic_summary_index['A>z'].runs).toEqual([{ sentences: [10, 11], text: '' }]);
    expect(llm.callLLMWithRetry).toHaveBeenCalledTimes(1);

    // (b) The leaf is persisted as a force-accepted empty summary, and the
    // transient marker does not survive finalization.
    expect(done.topic_summaries['A>z']).toEqual({
      runs: [{ sentences: [10, 11], text: '', forcedEmpty: true }],
      source_sentences: [10, 11],
      forcedEmpty: true,
    });
    expect(done.topic_summaries['A>x'].forcedEmpty).toBeUndefined();
    expect(done.summaryErrors).toEqual([]);
    expect(done.forceFinalize).toBe(false);
    expect(done.summariesDisabled).toBe(false);
    expect(done.summariesIncomplete).toBe(true);
  });

  it('leaves the skipped leaf retryable on a later run, unlike the successful ones', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);
    await writeRecord(makeParkedRecord('skipflow2'));
    llm.callLLMWithRetry.mockResolvedValue('PARENT');

    const { dispatchMessage, _resetJobRegistry } = await import('./background.js');
    _resetJobRegistry();
    await dispatchMessage({ type: 'resolveSummaryErrors', key: 'skipflow2', action: 'skip' }, {});
    await vi.waitFor(async () => {
      expect((await readRecord('skipflow2')).status).toBe('done');
    });
    expect(llm.callLLMWithRetry).toHaveBeenCalledTimes(1);

    // A later "Generate summaries" run plans against the PERSISTED summaries.
    const plan = planSummaryWork(
      TOPICS.map(({ name, sentences }) => ({ name, sentences })),
      (await readRecord('skipflow2')).topic_summaries,
    );
    expect(plan.pending.map((t) => t.name)).toEqual(['A>z']);
    expect(Object.keys(plan.reused).sort()).toEqual(['A>x', 'A>y']);
  });

  it('retries a later merge failure without losing an earlier accepted leaf', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);
    await writeRecord(makeParkedRecord('skip-then-retry'));
    llm.callLLMWithRetry
      .mockRejectedValueOnce(new Error('parent merge failed'))
      .mockResolvedValue('RETRIED UNAFFECTED PARENT');

    const { dispatchMessage, _resetJobRegistry } = await import('./background.js');
    _resetJobRegistry();
    await dispatchMessage(
      { type: 'resolveSummaryErrors', key: 'skip-then-retry', action: 'skip' },
      {},
    );
    await vi.waitFor(async () => {
      expect((await readRecord('skip-then-retry')).status).toBe('needs_attention');
    });
    const chainedReview = await readRecord('skip-then-retry');
    expect(chainedReview.topic_summaries['A>z'].acceptedFailure).toBe(true);
    expect(chainedReview.summaryErrors).toEqual([expect.objectContaining({ topic: 'A' })]);

    const retry = await dispatchMessage(
      { type: 'resolveSummaryErrors', key: 'skip-then-retry', action: 'retry' },
      {},
    );
    expect(retry.ok).toBe(true);
    await vi.waitFor(async () => {
      expect((await readRecord('skip-then-retry')).status).toBe('done');
    });

    const done = await readRecord('skip-then-retry');
    expect(llm.callLLMWithRetry).toHaveBeenCalledTimes(2);
    expect(llm.callLLMWithRetry.mock.calls[1][0].prompt).not.toContain(SENTENCES[9]);
    expect(done.topic_summary_index.A.runs).toEqual([
      { sentences: [1, 2, 3, 4], text: 'RETRIED UNAFFECTED PARENT' },
      { sentences: [10, 11], text: '' },
    ]);
    expect(done.topic_summaries['A>z'].forcedEmpty).toBe(true);
    expect(done.summariesIncomplete).toBe(true);
  });
});
