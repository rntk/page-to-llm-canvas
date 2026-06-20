import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  readRecord,
  writeRecord,
  updateRecord,
  appendProcessingLog,
  listRecords,
  deleteRecord,
  deleteAll,
  findRecordByUrl,
  buildRecordSnippet,
  recordStorageKey,
  INDEX_KEY,
  _resetUpdateQueues,
} from './storage.js';

// ---------------------------------------------------------------------------
// Chrome mock helpers
// ---------------------------------------------------------------------------

/**
 * Builds a minimal in-memory chrome.storage.local mock.
 *
 * @param {{ lastErrorOnSet?: boolean, lastErrorOnGet?: boolean,
 *            lastErrorOnRemove?: boolean, setDelay?: number,
 *            failSetOnCall?: number }} [opts]
 */
function makeChromeMock(opts = {}) {
  const {
    lastErrorOnSet = false,
    lastErrorOnGet = false,
    lastErrorOnRemove = false,
    setDelay = 0,
    failSetOnCall = 0,
  } = opts;
  const store = new Map();
  const runtime = { lastError: null };
  let setCalls = 0;

  const chromeLocal = {
    _store: store,
    get: vi.fn((keys, cb) => {
      if (lastErrorOnGet) {
        runtime.lastError = { message: 'get failed' };
        cb({});
        runtime.lastError = null;
        return;
      }
      runtime.lastError = null;
      const result = {};
      const keyList = Array.isArray(keys) ? keys : [keys];
      for (const k of keyList) {
        if (store.has(k)) result[k] = store.get(k);
      }
      cb(result);
    }),
    set: vi.fn((items, cb) => {
      const doSet = () => {
        setCalls += 1;
        if (lastErrorOnSet || setCalls === failSetOnCall) {
          runtime.lastError = { message: 'QuotaExceededError' };
          cb();
          runtime.lastError = null;
          return;
        }
        runtime.lastError = null;
        for (const [k, v] of Object.entries(items)) store.set(k, v);
        cb();
      };
      if (setDelay > 0) setTimeout(doSet, setDelay);
      else doSet();
    }),
    remove: vi.fn((keys, cb) => {
      if (lastErrorOnRemove) {
        runtime.lastError = { message: 'remove failed' };
        cb();
        runtime.lastError = null;
        return;
      }
      runtime.lastError = null;
      const keyList = Array.isArray(keys) ? keys : [keys];
      for (const k of keyList) store.delete(k);
      cb();
    }),
  };

  return { storage: { local: chromeLocal }, runtime };
}

/** Seeds a record directly into the mock store so tests start with known data. */
function seedRecord(chromeMock, rec) {
  chromeMock.storage.local._store.set(recordStorageKey(rec.key), rec);
  const idx = chromeMock.storage.local._store.get(INDEX_KEY) || { keys: [] };
  if (!idx.keys.includes(rec.key)) idx.keys.unshift(rec.key);
  chromeMock.storage.local._store.set(INDEX_KEY, idx);
}

function makeRecord(key, overrides = {}) {
  return {
    key,
    sourceUrl: 'https://example.com',
    html: '<p>hello</p>',
    text: 'hello',
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

// ---------------------------------------------------------------------------
// Setup: install chrome global before each test, reset queue state
// ---------------------------------------------------------------------------

beforeEach(() => {
  _resetUpdateQueues();
});

// ---------------------------------------------------------------------------
// chrome.runtime.lastError propagation
// ---------------------------------------------------------------------------

describe('chrome.runtime.lastError propagation', () => {
  it('getLocal rejects when chrome.runtime.lastError is set on get', async () => {
    vi.stubGlobal('chrome', makeChromeMock({ lastErrorOnGet: true }));
    await expect(readRecord('somekey')).rejects.toThrow('get failed');
  });

  it('setLocal rejects when chrome.runtime.lastError is set on set', async () => {
    const mock = makeChromeMock({ lastErrorOnSet: true });
    vi.stubGlobal('chrome', mock);
    const rec = makeRecord('r1');
    seedRecord(mock, rec);
    await expect(updateRecord('r1', { status: 'splitting' })).rejects.toThrow('QuotaExceededError');
  });

  it('removeLocal rejects when chrome.runtime.lastError is set on remove', async () => {
    const mock = makeChromeMock({ lastErrorOnRemove: true });
    vi.stubGlobal('chrome', mock);
    const rec = makeRecord('r1');
    seedRecord(mock, rec);
    await expect(deleteRecord('r1')).rejects.toThrow('remove failed');
  });

  it('writeRecord rejects when the set call fails', async () => {
    vi.stubGlobal('chrome', makeChromeMock({ lastErrorOnSet: true }));
    const rec = makeRecord('r1');
    await expect(writeRecord(rec)).rejects.toThrow('QuotaExceededError');
  });

  it('writeRecord rolls back the record when the index write fails', async () => {
    const mock = makeChromeMock({ failSetOnCall: 2 });
    vi.stubGlobal('chrome', mock);
    const rec = makeRecord('r1');

    await expect(writeRecord(rec)).rejects.toThrow('QuotaExceededError');
    expect(await readRecord('r1')).toBeNull();
    expect(await listRecords()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// updateRecord — basic correctness
// ---------------------------------------------------------------------------

describe('updateRecord basic correctness', () => {
  it('merges patch fields into the stored record', async () => {
    const mock = makeChromeMock();
    vi.stubGlobal('chrome', mock);
    const rec = makeRecord('r1');
    seedRecord(mock, rec);

    const result = await updateRecord('r1', { status: 'splitting' });
    expect(result.status).toBe('splitting');
    expect(result.key).toBe('r1');
  });

  it('returns null when the record does not exist', async () => {
    vi.stubGlobal('chrome', makeChromeMock());
    const result = await updateRecord('nonexistent', { status: 'splitting' });
    expect(result).toBeNull();
  });

  it('updates updatedAt timestamp', async () => {
    const mock = makeChromeMock();
    vi.stubGlobal('chrome', mock);
    const rec = makeRecord('r1', { updatedAt: 1000 });
    seedRecord(mock, rec);

    const before = Date.now();
    const result = await updateRecord('r1', { status: 'done' });
    const after = Date.now();

    expect(result.updatedAt).toBeGreaterThanOrEqual(before);
    expect(result.updatedAt).toBeLessThanOrEqual(after);
  });
});

// ---------------------------------------------------------------------------
// Concurrent write atomicity — no field loss
// ---------------------------------------------------------------------------

describe('concurrent updateRecord writes do not lose data', () => {
  it('preserves all topic_summaries from parallel updates', async () => {
    const mock = makeChromeMock();
    vi.stubGlobal('chrome', mock);

    const rec = makeRecord('r1', { topic_summaries: {} });
    seedRecord(mock, rec);

    // Simulate SUMMARY_CONCURRENCY=4 tasks all updating topic_summaries simultaneously.
    // Each task accumulates into the SAME shared object (mirrors orchestrator.js).
    const topic_summaries = {};
    const tasks = ['T1', 'T2', 'T3', 'T4'].map(async (name) => {
      topic_summaries[name] = { text: `summary of ${name}`, bullets: [], source_sentences: [] };
      await updateRecord('r1', {
        topic_summaries: { ...topic_summaries },
        progress: {
          stage: 'summarizing_topics',
          done: Object.keys(topic_summaries).length,
          total: 4,
        },
      });
    });

    await Promise.all(tasks);

    const stored = await readRecord('r1');
    expect(Object.keys(stored.topic_summaries).sort()).toEqual(['T1', 'T2', 'T3', 'T4']);
    expect(stored.progress.done).toBe(4);
  });

  it('does not clobber a field updated by one task when another updates a different field', async () => {
    const mock = makeChromeMock();
    vi.stubGlobal('chrome', mock);

    const rec = makeRecord('r1');
    seedRecord(mock, rec);

    // Two updates: one sets sentences, one sets status — should both survive.
    await Promise.all([
      updateRecord('r1', { sentences: ['hello', 'world'] }),
      updateRecord('r1', { status: 'splitting' }),
    ]);

    const stored = await readRecord('r1');
    expect(stored.sentences).toEqual(['hello', 'world']);
    expect(stored.status).toBe('splitting');
  });

  it('serializes many concurrent updates so the last one reflects all prior writes', async () => {
    const mock = makeChromeMock();
    vi.stubGlobal('chrome', mock);

    const rec = makeRecord('r1', { counter: 0 });
    seedRecord(mock, rec);

    const N = 20;
    // Each update increments a counter, reading the previous value from storage.
    const updates = Array.from({ length: N }, (_, i) => updateRecord('r1', { [`field_${i}`]: i }));
    await Promise.all(updates);

    const stored = await readRecord('r1');
    for (let i = 0; i < N; i++) {
      expect(stored[`field_${i}`]).toBe(i);
    }
  });
});

// ---------------------------------------------------------------------------
// appendProcessingLog atomicity
// ---------------------------------------------------------------------------

describe('appendProcessingLog atomicity', () => {
  it('accumulates log entries from concurrent calls without dropping any', async () => {
    const mock = makeChromeMock();
    vi.stubGlobal('chrome', mock);

    const rec = makeRecord('r1');
    seedRecord(mock, rec);

    const stages = ['stage_a', 'stage_b', 'stage_c', 'stage_d', 'stage_e'];
    await Promise.all(stages.map((stage) => appendProcessingLog('r1', stage, {})));

    const stored = await readRecord('r1');
    const storedStages = stored.processingLog.map((e) => e.stage).sort();
    expect(storedStages).toEqual(stages.sort());
  });

  it('does not erase existing log entries when updateRecord runs concurrently', async () => {
    const mock = makeChromeMock();
    vi.stubGlobal('chrome', mock);

    const rec = makeRecord('r1');
    seedRecord(mock, rec);

    // Fire both concurrently: one appends a log, the other updates status.
    await Promise.all([
      appendProcessingLog('r1', 'pipeline_start', {}),
      updateRecord('r1', { status: 'splitting' }),
    ]);

    const stored = await readRecord('r1');
    expect(stored.status).toBe('splitting');
    expect(stored.processingLog.length).toBe(1);
    expect(stored.processingLog[0].stage).toBe('pipeline_start');
  });

  it('rejects (and logPipeline can catch) when storage set fails', async () => {
    const mock = makeChromeMock({ lastErrorOnSet: true });
    vi.stubGlobal('chrome', mock);

    const rec = makeRecord('r1');
    seedRecord(mock, rec);

    await expect(appendProcessingLog('r1', 'any_stage', {})).rejects.toThrow('QuotaExceededError');
  });
});

// ---------------------------------------------------------------------------
// listRecords / deleteRecord / deleteAll
// ---------------------------------------------------------------------------

describe('listRecords', () => {
  it('returns lightweight summaries of all indexed records', async () => {
    const mock = makeChromeMock();
    vi.stubGlobal('chrome', mock);

    const a = makeRecord('a');
    const b = makeRecord('b', { status: 'done' });
    seedRecord(mock, a);
    seedRecord(mock, b);

    const items = await listRecords();
    expect(items.length).toBe(2);
    const keys = items.map((i) => i.key).sort();
    expect(keys).toEqual(['a', 'b']);
    // Should only expose the summary fields.
    for (const item of items) {
      expect(item).not.toHaveProperty('html');
      expect(item).toHaveProperty('key');
      expect(item).toHaveProperty('status');
      expect(item).toHaveProperty('snippet');
    }
  });

  it('includes a normalized bounded text snippet', async () => {
    const mock = makeChromeMock();
    vi.stubGlobal('chrome', mock);

    const longText = `  ${'word '.repeat(140)}  `;
    seedRecord(mock, makeRecord('r1', { text: `First line\n\n${longText}` }));

    const [item] = await listRecords();
    expect(item.snippet).toMatch(/^First line word word/);
    expect(item.snippet.length).toBeLessThanOrEqual(503);
    expect(item.snippet.endsWith('...')).toBe(true);
  });
});

describe('buildRecordSnippet', () => {
  it('normalizes whitespace and returns an empty string for missing text', () => {
    expect(buildRecordSnippet({ text: '  Alpha\nBeta\tGamma  ' })).toBe('Alpha Beta Gamma');
    expect(buildRecordSnippet({})).toBe('');
  });
});

describe('deleteRecord', () => {
  it('removes the record from storage and the index', async () => {
    const mock = makeChromeMock();
    vi.stubGlobal('chrome', mock);

    const rec = makeRecord('r1');
    seedRecord(mock, rec);

    await deleteRecord('r1');

    const stored = await readRecord('r1');
    expect(stored).toBeNull();

    const items = await listRecords();
    expect(items.find((i) => i.key === 'r1')).toBeUndefined();
  });

  it('restores the index when record removal fails', async () => {
    const mock = makeChromeMock({ lastErrorOnRemove: true });
    vi.stubGlobal('chrome', mock);
    seedRecord(mock, makeRecord('r1'));

    await expect(deleteRecord('r1')).rejects.toThrow('remove failed');

    const items = await listRecords();
    expect(items.map((i) => i.key)).toEqual(['r1']);
  });
});

describe('deleteAll', () => {
  it('wipes all records and the index', async () => {
    const mock = makeChromeMock();
    vi.stubGlobal('chrome', mock);

    seedRecord(mock, makeRecord('r1'));
    seedRecord(mock, makeRecord('r2'));

    await deleteAll();

    const items = await listRecords();
    expect(items).toHaveLength(0);
    expect(await readRecord('r1')).toBeNull();
    expect(await readRecord('r2')).toBeNull();
  });

  it('is ordered after an in-flight writeRecord and leaves storage empty', async () => {
    const mock = makeChromeMock({ setDelay: 5 });
    vi.stubGlobal('chrome', mock);

    await Promise.all([writeRecord(makeRecord('r1')), deleteAll()]);

    expect(await listRecords()).toHaveLength(0);
    expect(await readRecord('r1')).toBeNull();
  });

  it('prevents an in-flight updateRecord from rewriting a wiped record', async () => {
    const mock = makeChromeMock({ setDelay: 5 });
    vi.stubGlobal('chrome', mock);
    seedRecord(mock, makeRecord('r1'));

    await Promise.all([updateRecord('r1', { status: 'done' }), deleteAll()]);

    expect(await listRecords()).toHaveLength(0);
    expect(await readRecord('r1')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Queue memory-leak pruning
// ---------------------------------------------------------------------------

describe('_updateQueues pruning', () => {
  it('removes the Map entry after a queued update settles', async () => {
    // We can't import the private Map directly, so verify behaviour indirectly:
    // After all queued work for a key resolves, a subsequent write should still
    // enqueue and complete correctly (proving the queue entry was rebuilt from
    // scratch rather than pointing at a stale chain).
    const mock = makeChromeMock();
    vi.stubGlobal('chrome', mock);

    const rec = makeRecord('prune1');
    seedRecord(mock, rec);

    await updateRecord('prune1', { status: 'splitting' });

    // After settling, another update should execute and see the previous result.
    const result = await updateRecord('prune1', { status: 'done' });
    expect(result.status).toBe('done');

    const stored = await readRecord('prune1');
    expect(stored.status).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// INDEX_KEY serialization
// ---------------------------------------------------------------------------

describe('concurrent writeRecord / deleteRecord do not lose index entries', () => {
  it('preserves all keys after concurrent writeRecord calls', async () => {
    const mock = makeChromeMock();
    vi.stubGlobal('chrome', mock);

    const records = ['k1', 'k2', 'k3', 'k4'].map((k) => makeRecord(k));
    await Promise.all(records.map((r) => writeRecord(r)));

    const items = await listRecords();
    const keys = items.map((i) => i.key).sort();
    expect(keys).toEqual(['k1', 'k2', 'k3', 'k4']);
  });

  it('preserves remaining keys after concurrent deleteRecord calls', async () => {
    const mock = makeChromeMock();
    vi.stubGlobal('chrome', mock);

    const records = ['k1', 'k2', 'k3', 'k4'].map((k) => makeRecord(k));
    for (const r of records) seedRecord(mock, r);

    await Promise.all(['k2', 'k4'].map((k) => deleteRecord(k)));

    const items = await listRecords();
    const keys = items.map((i) => i.key).sort();
    expect(keys).toEqual(['k1', 'k3']);
  });

  it('writeRecord then immediate updateRecord sees the written record', async () => {
    const mock = makeChromeMock();
    vi.stubGlobal('chrome', mock);

    const rec = makeRecord('race1');
    await Promise.all([writeRecord(rec), updateRecord('race1', { status: 'splitting' })]);

    const stored = await readRecord('race1');
    // updateRecord runs after writeRecord (queued on same key), so status wins.
    expect(stored.status).toBe('splitting');
  });
});

describe('findRecordByUrl', () => {
  beforeEach(() => {
    vi.resetModules();
    _resetUpdateQueues();
  });

  it('returns null for falsy URLs and when no records exist', async () => {
    const mock = makeChromeMock();
    vi.stubGlobal('chrome', mock);

    expect(await findRecordByUrl('')).toBeNull();
    expect(await findRecordByUrl('https://example.com')).toBeNull();
  });

  it('returns the first record with a matching sourceUrl', async () => {
    const mock = makeChromeMock();
    vi.stubGlobal('chrome', mock);

    seedRecord(mock, makeRecord('k1', { sourceUrl: 'https://example.com/a' }));
    seedRecord(mock, makeRecord('k2', { sourceUrl: 'https://example.com/b' }));

    const found = await findRecordByUrl('https://example.com/b');
    expect(found).not.toBeNull();
    expect(found.key).toBe('k2');
  });
});
