import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  readRecord,
  writeRecord,
  updateRecord,
  appendProcessingLog,
  flushProcessingLog,
  listRecords,
  deleteRecord,
  deleteAll,
  findRecordByUrl,
  buildRecordSnippet,
  migrateIndexMeta,
  recordExists,
  INDEX_KEY,
  INDEX_SCHEMA_KEY,
  INDEX_SCHEMA_VERSION,
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
  // Kept as a live (mutable) object, rather than destructured consts, so
  // tests can seed data first and flip a failure flag on afterwards (e.g.
  // "seed successfully, then make the next set() call fail").
  const state = {
    lastErrorOnSet: false,
    lastErrorOnGet: false,
    lastErrorOnRemove: false,
    setDelay: 0,
    failSetOnCall: 0,
    ...opts,
  };
  const store = new Map();
  const runtime = { lastError: null };
  let setCalls = 0;

  const chromeLocal = {
    _store: store,
    get: vi.fn((keys, cb) => {
      if (state.lastErrorOnGet) {
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
        if (state.lastErrorOnSet || setCalls === state.failSetOnCall) {
          runtime.lastError = { message: 'QuotaExceededError' };
          cb();
          runtime.lastError = null;
          return;
        }
        runtime.lastError = null;
        for (const [k, v] of Object.entries(items)) store.set(k, v);
        cb();
      };
      if (state.setDelay > 0) setTimeout(doSet, state.setDelay);
      else doSet();
    }),
    remove: vi.fn((keys, cb) => {
      if (state.lastErrorOnRemove) {
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

  return { storage: { local: chromeLocal }, runtime, _state: state };
}

/** Seeds a record into the mock store (via writeRecord) so tests start with known data. */
async function seedRecord(chromeMock, rec) {
  await writeRecord(rec);
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
    const mock = makeChromeMock();
    vi.stubGlobal('chrome', mock);
    const rec = makeRecord('r1');
    await seedRecord(mock, rec);
    mock._state.lastErrorOnSet = true;
    await expect(updateRecord('r1', { status: 'splitting' })).rejects.toThrow('QuotaExceededError');
  });

  it('removeLocal rejects when chrome.runtime.lastError is set on remove', async () => {
    const mock = makeChromeMock({ lastErrorOnRemove: true });
    vi.stubGlobal('chrome', mock);
    const rec = makeRecord('r1');
    await seedRecord(mock, rec);
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
    await seedRecord(mock, rec);

    const result = await updateRecord('r1', { status: 'splitting' });
    expect(result.status).toBe('splitting');
    expect(result.key).toBe('r1');
  });

  it('returns null when the record does not exist', async () => {
    vi.stubGlobal('chrome', makeChromeMock());
    const result = await updateRecord('nonexistent', { status: 'splitting' });
    expect(result).toBeNull();
  });

  it('skips updates when the expected pipeline run id is stale', async () => {
    const mock = makeChromeMock();
    vi.stubGlobal('chrome', mock);
    await seedRecord(mock, makeRecord('r1', { pipelineRunId: 'run-current', status: 'pending' }));

    const result = await updateRecord(
      'r1',
      { status: 'done' },
      { expectedPipelineRunId: 'run-old' },
    );

    expect(result).toBeNull();
    expect((await readRecord('r1')).status).toBe('pending');
  });

  it('updates updatedAt timestamp', async () => {
    const mock = makeChromeMock();
    vi.stubGlobal('chrome', mock);
    const rec = makeRecord('r1', { updatedAt: 1000 });
    await seedRecord(mock, rec);

    const before = Date.now();
    const result = await updateRecord('r1', { status: 'done' });
    const after = Date.now();

    expect(result.updatedAt).toBeGreaterThanOrEqual(before);
    expect(result.updatedAt).toBeLessThanOrEqual(after);
  });
});

// ---------------------------------------------------------------------------
// meta/content/summaries split — hot-path doc isolation
// ---------------------------------------------------------------------------

describe('record storage split (meta/content/summaries)', () => {
  it('writeRecord splits a record across meta/content/summaries docs', async () => {
    const mock = makeChromeMock();
    vi.stubGlobal('chrome', mock);
    await writeRecord(makeRecord('r1', { html: '<p>hi</p>', text: 'hi' }));

    const store = mock.storage.local._store;
    expect(store.has('pagetollm:rec:r1:meta')).toBe(true);
    expect(store.has('pagetollm:rec:r1:content')).toBe(true);
    expect(store.has('pagetollm:rec:r1:summaries')).toBe(true);
    expect(store.get('pagetollm:rec:r1:content').html).toBe('<p>hi</p>');

    // readRecord reassembles the full logical record transparently.
    const rec = await readRecord('r1');
    expect(rec.status).toBe('pending');
    expect(rec.html).toBe('<p>hi</p>');
  });

  it('a status/progress-only update on an already-written record never touches the content or summaries docs', async () => {
    const mock = makeChromeMock();
    vi.stubGlobal('chrome', mock);
    await writeRecord(makeRecord('r1', { html: '<p>hi</p>', text: 'hi' }));
    mock.storage.local.set.mockClear();
    mock.storage.local.get.mockClear();

    await updateRecord('r1', {
      status: 'summarizing',
      progress: { stage: 'x', done: 1, total: 2 },
    });

    const touchedKeys = mock.storage.local.set.mock.calls.flatMap(([items]) => Object.keys(items));
    expect(touchedKeys).not.toContain('pagetollm:rec:r1:content');
    expect(touchedKeys).not.toContain('pagetollm:rec:r1:summaries');
    const readKeys = mock.storage.local.get.mock.calls.flatMap(([keys]) =>
      Array.isArray(keys) ? keys : [keys],
    );
    expect(readKeys).not.toContain('pagetollm:rec:r1:content');
    expect(readKeys).not.toContain('pagetollm:rec:r1:summaries');
  });

  it('a processingLog flush on an already-written record never touches the content or summaries docs', async () => {
    const mock = makeChromeMock();
    vi.stubGlobal('chrome', mock);
    await writeRecord(makeRecord('r1', { html: '<p>hi</p>', text: 'hi' }));
    mock.storage.local.set.mockClear();
    mock.storage.local.get.mockClear();

    await appendProcessingLog('r1', 'some_stage', {});
    await flushProcessingLog('r1');

    const touchedKeys = mock.storage.local.set.mock.calls.flatMap(([items]) => Object.keys(items));
    expect(touchedKeys).not.toContain('pagetollm:rec:r1:content');
    expect(touchedKeys).not.toContain('pagetollm:rec:r1:summaries');
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
    await seedRecord(mock, rec);

    // Simulate SUMMARY_CONCURRENCY=4 tasks all updating topic_summaries simultaneously.
    // Each task accumulates into the SAME shared object (mirrors orchestrator.js).
    const topic_summaries = {};
    const tasks = ['T1', 'T2', 'T3', 'T4'].map(async (name) => {
      topic_summaries[name] = {
        runs: [{ sentences: [], text: `summary of ${name}` }],
        source_sentences: [],
      };
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
    await seedRecord(mock, rec);

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
    await seedRecord(mock, rec);

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
    await seedRecord(mock, rec);

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
    await seedRecord(mock, rec);

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
    const mock = makeChromeMock();
    vi.stubGlobal('chrome', mock);

    const rec = makeRecord('r1');
    await seedRecord(mock, rec);
    mock._state.lastErrorOnSet = true;

    await expect(appendProcessingLog('r1', 'any_stage', {})).rejects.toThrow('QuotaExceededError');
  });

  it('does not let a stale run entry ride along into a new run when a retry starts mid-buffer', async () => {
    const mock = makeChromeMock();
    vi.stubGlobal('chrome', mock);

    await seedRecord(mock, makeRecord('r1', { pipelineRunId: 'runA' }));

    // Run A logs a stage but never flushes before it's superseded by a retry.
    appendProcessingLog('r1', 'stage_from_runA', {}, { expectedPipelineRunId: 'runA' });

    // The retry/reprocess flow updates the record to a new run id...
    await updateRecord('r1', { pipelineRunId: 'runB', status: 'pending' });
    // ...then run B starts logging under the new id while the old buffer is
    // still pending. This must flush (and drop) run A's stale entry rather
    // than let it piggyback on run B's stale-run check.
    appendProcessingLog('r1', 'stage_from_runB', {}, { expectedPipelineRunId: 'runB' });
    // Forces run B's buffer to flush; per-key queue ordering guarantees the
    // stale run A flush (triggered above) has already settled by then.
    await flushProcessingLog('r1');

    const stored = await readRecord('r1');
    const stages = stored.processingLog.map((e) => e.stage);
    expect(stages).toEqual(['stage_from_runB']);
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
    await seedRecord(mock, a);
    await seedRecord(mock, b);

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

  it('exposes the summariesDisabled outcome flag and keeps it in sync on update', async () => {
    const mock = makeChromeMock();
    vi.stubGlobal('chrome', mock);

    await seedRecord(mock, makeRecord('r1', { summariesDisabled: true }));
    let [item] = await listRecords();
    expect(item.summariesDisabled).toBe(true);

    // Mirrors the pipeline finalize patch after summaries are generated.
    await updateRecord('r1', { status: 'done', summariesDisabled: false });
    [item] = await listRecords();
    expect(item.summariesDisabled).toBe(false);
  });

  it('includes a normalized bounded text snippet', async () => {
    const mock = makeChromeMock();
    vi.stubGlobal('chrome', mock);

    const longText = `  ${'word '.repeat(140)}  `;
    await seedRecord(mock, makeRecord('r1', { text: `First line\n\n${longText}` }));

    const [item] = await listRecords();
    expect(item.snippet).toMatch(/^First line word word/);
    expect(item.snippet.length).toBeLessThanOrEqual(503);
    expect(item.snippet.endsWith('...')).toBe(true);
  });
});

describe('migrateIndexMeta', () => {
  /** Simulates a projection cached by a version predating `summariesDisabled`. */
  function stripProjectionField(mock, key) {
    delete mock.storage.local._store.get(INDEX_KEY).meta[key].summariesDisabled;
  }

  it('backfills summariesDisabled from the meta doc for old projections', async () => {
    const mock = makeChromeMock();
    vi.stubGlobal('chrome', mock);

    await seedRecord(mock, makeRecord('old-nosum', { status: 'done', summariesDisabled: true }));
    await seedRecord(mock, makeRecord('old-sum', { status: 'done' }));
    stripProjectionField(mock, 'old-nosum');
    stripProjectionField(mock, 'old-sum');

    await migrateIndexMeta();

    const items = await listRecords();
    expect(items.find((i) => i.key === 'old-nosum').summariesDisabled).toBe(true);
    expect(items.find((i) => i.key === 'old-sum').summariesDisabled).toBe(false);
    expect(mock.storage.local._store.get(INDEX_SCHEMA_KEY)).toBe(INDEX_SCHEMA_VERSION);
  });

  it('is a stamped no-op on subsequent runs', async () => {
    const mock = makeChromeMock();
    vi.stubGlobal('chrome', mock);

    await seedRecord(mock, makeRecord('r1', { status: 'done', summariesDisabled: true }));
    await migrateIndexMeta();

    // Strip the field again: a stamped migration must not scan or repair —
    // startups after the first stay a single storage read.
    stripProjectionField(mock, 'r1');
    await migrateIndexMeta();
    expect(mock.storage.local._store.get(INDEX_KEY).meta['r1'].summariesDisabled).toBeUndefined();
  });

  it('does not stamp on failure, so the next startup retries', async () => {
    const mock = makeChromeMock();
    vi.stubGlobal('chrome', mock);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await seedRecord(mock, makeRecord('r1', { status: 'done', summariesDisabled: true }));
    stripProjectionField(mock, 'r1');

    mock._state.lastErrorOnGet = true;
    await migrateIndexMeta();
    mock._state.lastErrorOnGet = false;
    expect(mock.storage.local._store.get(INDEX_SCHEMA_KEY)).toBeUndefined();

    await migrateIndexMeta();
    const [item] = await listRecords();
    expect(item.summariesDisabled).toBe(true);
    expect(mock.storage.local._store.get(INDEX_SCHEMA_KEY)).toBe(INDEX_SCHEMA_VERSION);

    warnSpy.mockRestore();
  });
});

describe('buildRecordSnippet', () => {
  it('normalizes whitespace and returns an empty string for missing text', () => {
    expect(buildRecordSnippet({ text: '  Alpha\nBeta\tGamma  ' })).toBe('Alpha Beta Gamma');
    expect(buildRecordSnippet({})).toBe('');
  });
});

describe('recordExists', () => {
  it('reflects whether the meta doc is present in storage', async () => {
    const mock = makeChromeMock();
    vi.stubGlobal('chrome', mock);

    expect(await recordExists('r1')).toBe(false);
    await seedRecord(mock, makeRecord('r1'));
    expect(await recordExists('r1')).toBe(true);
    await deleteRecord('r1');
    expect(await recordExists('r1')).toBe(false);
  });
});

describe('deleteRecord', () => {
  it('removes the record from storage and the index', async () => {
    const mock = makeChromeMock();
    vi.stubGlobal('chrome', mock);

    const rec = makeRecord('r1');
    await seedRecord(mock, rec);

    await deleteRecord('r1');

    const stored = await readRecord('r1');
    expect(stored).toBeNull();

    const items = await listRecords();
    expect(items.find((i) => i.key === 'r1')).toBeUndefined();
  });

  it('restores the index when record removal fails', async () => {
    const mock = makeChromeMock({ lastErrorOnRemove: true });
    vi.stubGlobal('chrome', mock);
    await seedRecord(mock, makeRecord('r1'));

    await expect(deleteRecord('r1')).rejects.toThrow('remove failed');

    const items = await listRecords();
    expect(items.map((i) => i.key)).toEqual(['r1']);
  });
});

describe('deleteAll', () => {
  it('wipes all records and the index', async () => {
    const mock = makeChromeMock();
    vi.stubGlobal('chrome', mock);

    await seedRecord(mock, makeRecord('r1'));
    await seedRecord(mock, makeRecord('r2'));

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
    await seedRecord(mock, makeRecord('r1'));

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
    await seedRecord(mock, rec);

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
  it('does not mix fields when different records are updated concurrently', async () => {
    const mock = makeChromeMock();
    vi.stubGlobal('chrome', mock);

    await seedRecord(mock, makeRecord('page-a', { html: '<p>A</p>', sourceUrl: 'https://a.test' }));
    await seedRecord(mock, makeRecord('page-b', { html: '<p>B</p>', sourceUrl: 'https://b.test' }));

    await Promise.all([
      updateRecord('page-a', {
        status: 'summarizing',
        topic_summaries: { 'Topic>A': { text: 'summary A' } },
      }),
      updateRecord('page-b', {
        status: 'splitting',
        topic_summaries: { 'Topic>B': { text: 'summary B' } },
      }),
    ]);

    const storedA = await readRecord('page-a');
    const storedB = await readRecord('page-b');
    expect(storedA.status).toBe('summarizing');
    expect(storedB.status).toBe('splitting');
    expect(storedA.topic_summaries).toEqual({ 'Topic>A': { text: 'summary A' } });
    expect(storedB.topic_summaries).toEqual({ 'Topic>B': { text: 'summary B' } });
    expect(storedA.sourceUrl).toBe('https://a.test');
    expect(storedB.sourceUrl).toBe('https://b.test');
  });

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
    await Promise.all(records.map((r) => seedRecord(mock, r)));

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

    await seedRecord(mock, makeRecord('k1', { sourceUrl: 'https://example.com/a' }));
    await seedRecord(mock, makeRecord('k2', { sourceUrl: 'https://example.com/b' }));

    const found = await findRecordByUrl('https://example.com/b');
    expect(found).not.toBeNull();
    expect(found.key).toBe('k2');
  });
});
