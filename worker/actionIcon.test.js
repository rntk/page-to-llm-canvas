import { describe, it, expect, beforeEach, vi } from 'vitest';
import { writeRecord } from './storage/storage.js';

function makeChromeMock() {
  const store = new Map();
  const runtime = { lastError: null };

  const chromeLocal = {
    _store: store,
    get: vi.fn((keys, cb) => {
      runtime.lastError = null;
      const result = {};
      const keyList = Array.isArray(keys) ? keys : [keys];
      for (const k of keyList) {
        if (store.has(k)) result[k] = store.get(k);
      }
      cb(result);
    }),
    set: vi.fn((items, cb) => {
      runtime.lastError = null;
      for (const [k, v] of Object.entries(items)) store.set(k, v);
      cb();
    }),
    remove: vi.fn((keys, cb) => {
      runtime.lastError = null;
      const keyList = Array.isArray(keys) ? keys : [keys];
      for (const k of keyList) store.delete(k);
      cb();
    }),
  };

  return {
    storage: {
      local: chromeLocal,
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    runtime: {
      ...runtime,
      getURL: vi.fn((path = '') => `chrome-extension://test-id/${path}`),
      sendMessage: vi.fn(),
      onMessage: { addListener: vi.fn() },
    },
    alarms: {
      create: vi.fn(),
      clear: vi.fn(),
      get: vi.fn((_name, cb) => cb(undefined)),
      onAlarm: { addListener: vi.fn() },
    },
    action: {
      setBadgeText: vi.fn(),
      setBadgeBackgroundColor: vi.fn(),
      setIcon: vi.fn(),
    },
  };
}

// Records are physically split across `:meta`/`:content`/`:summaries` docs
// (see worker/storage/storage.js); seeding/reading a record for a test goes through
// the same writeRecord/readRecord functions the pipeline itself uses, rather
// than poking the mock store directly. Requires `chrome` to already be
// stubbed to `chromeMock` (writeRecord/readRecord read the global).
async function seedRecord(chromeMock, rec) {
  await writeRecord(rec);
}

function makeRecord(key, overrides = {}) {
  return {
    key,
    sourceUrl: 'https://example.com',
    html: '<p>hello</p>',
    text: '',
    status: 'pending',
    error: null,
    progress: { stage: 'queued', done: 0, total: 0 },
    sentences: [],
    topics: [],
    topic_summaries: {},
    topic_summary_index: {},
    processingLog: [],
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

describe('action icon progress rendering', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('summarizes idle action icon state', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);

    const { summarizeProcessingState } = await import('./actionIcon.js');

    expect(summarizeProcessingState([{ status: 'done' }, { status: 'error' }])).toEqual({
      active: false,
      count: 0,
      ratio: 0,
    });
  });

  it('treats a parked (needs_attention) record as not in-flight', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);

    const { summarizeProcessingState } = await import('./actionIcon.js');

    // The "won't auto-resume" invariant for needs_attention rests entirely on it
    // staying outside the shared in-flight status definition.
    expect(
      summarizeProcessingState([
        { status: 'needs_attention', progress: { stage: 'needs_attention', done: 1, total: 2 } },
      ]),
    ).toEqual({ active: false, count: 0, ratio: 0 });
  });

  it('summarizes indeterminate action icon state for queued work', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);

    const { summarizeProcessingState } = await import('./actionIcon.js');
    const state = summarizeProcessingState([
      { status: 'pending', progress: { stage: 'queued', done: 0, total: 0 } },
    ]);

    expect(state.active).toBe(true);
    expect(state.count).toBe(1);
    expect(state.ratio).toBeGreaterThan(0);
    expect(state.ratio).toBeLessThan(1);
  });

  it('summarizes determinate action icon progress across in-flight records', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);

    const { summarizeProcessingState } = await import('./actionIcon.js');
    const state = summarizeProcessingState([
      { status: 'summarizing', progress: { stage: 'summarizing_topics', done: 2, total: 4 } },
      { status: 'splitting', progress: { stage: 'topic_ranges', done: 3, total: 6 } },
      { status: 'done', progress: { stage: 'done', done: 1, total: 1 } },
    ]);

    expect(state.active).toBe(true);
    expect(state.count).toBe(2);
    expect(state.ratio).toBeCloseTo(0.5);
  });

  it('updates the toolbar badge and progress icon for in-flight records', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);
    await seedRecord(
      chromeMock,
      makeRecord('busy1', {
        status: 'summarizing',
        progress: { stage: 'summarizing_topics', done: 1, total: 2 },
      }),
    );
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        constructor(w, h) {
          this.width = w;
          this.height = h;
        }
        getContext() {
          return {
            drawImage: vi.fn(),
            fillStyle: '',
            beginPath: vi.fn(),
            roundRect: vi.fn(),
            fill: vi.fn(),
            getImageData: () => ({ data: new Uint8ClampedArray(4) }),
          };
        }
      },
    );
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => ({})),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        blob: async () => new Blob(),
      })),
    );

    const { refreshActionProgressIcon } = await import('./actionIcon.js');
    await refreshActionProgressIcon();
    // vi.waitFor only retries while its callback throws — a callback that
    // merely returns a boolean (the previous form here) resolves on its very
    // first tick regardless of the value, so it never actually waited for the
    // async badge update. Assert (which throws on failure) so it genuinely
    // polls until the badge call lands.
    await vi.waitFor(() => {
      expect(chromeMock.action.setBadgeText.mock.calls.length).toBeGreaterThan(0);
    });

    expect(chromeMock.action.setBadgeBackgroundColor).toHaveBeenCalled();
    expect(chromeMock.action.setBadgeText).toHaveBeenCalledWith({ text: '...' });
    vi.unstubAllGlobals();
  });
});
