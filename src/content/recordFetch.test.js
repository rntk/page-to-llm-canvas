// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  fetchRecord,
  findPickedElements,
  assessRecordForRail,
  createLoadToken,
} from './recordFetch.js';

// ---------------------------------------------------------------------------
// fetchRecord
// ---------------------------------------------------------------------------

describe('fetchRecord', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves with the record when the response is ok', async () => {
    const record = { key: 'k1', status: 'done' };
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage: vi.fn((msg, cb) => cb({ ok: true, record })),
        lastError: undefined,
      },
    });
    const result = await fetchRecord('k1');
    expect(result).toEqual(record);
  });

  it('resolves null when response ok is false', async () => {
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage: vi.fn((msg, cb) => cb({ ok: false })),
        lastError: undefined,
      },
    });
    const result = await fetchRecord('k1');
    expect(result).toBeNull();
  });

  it('resolves null when response is null/undefined', async () => {
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage: vi.fn((msg, cb) => cb(null)),
        lastError: undefined,
      },
    });
    const result = await fetchRecord('k1');
    expect(result).toBeNull();
  });

  it('resolves null on chrome.runtime.lastError', async () => {
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage: vi.fn((msg, cb) => {
          // Simulate lastError being set at callback time
          Object.defineProperty(globalThis.chrome.runtime, 'lastError', {
            value: { message: 'Extension context invalidated.' },
            configurable: true,
          });
          cb({ ok: true, record: { key: 'k1' } });
        }),
        lastError: undefined,
      },
    });
    const result = await fetchRecord('k1');
    expect(result).toBeNull();
  });

  it('resolves null when sendMessage throws', async () => {
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage: vi.fn(() => {
          throw new Error('no chrome');
        }),
        lastError: undefined,
      },
    });
    const result = await fetchRecord('k1');
    expect(result).toBeNull();
  });

  it('passes the correct message type and key', async () => {
    const sendMessage = vi.fn((msg, cb) => cb({ ok: true, record: { key: 'abc' } }));
    vi.stubGlobal('chrome', {
      runtime: { sendMessage, lastError: undefined },
    });
    await fetchRecord('abc');
    expect(sendMessage).toHaveBeenCalledWith(
      { type: 'getRecord', key: 'abc' },
      expect.any(Function),
    );
  });
});

// ---------------------------------------------------------------------------
// findPickedElements
// ---------------------------------------------------------------------------

describe('findPickedElements', () => {
  let container;

  beforeEach(() => {
    container = document.createElement('div');
    container.id = 'fpe-fixture';
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it('returns empty array for non-array input', () => {
    expect(findPickedElements(null)).toEqual([]);
    expect(findPickedElements(undefined)).toEqual([]);
    expect(findPickedElements('body')).toEqual([]);
    expect(findPickedElements(42)).toEqual([]);
  });

  it('returns empty array for empty selector list', () => {
    expect(findPickedElements([])).toEqual([]);
  });

  it('finds elements that exist in the document', () => {
    const el = document.createElement('section');
    el.id = 'fpe-section';
    container.appendChild(el);
    const result = findPickedElements(['#fpe-section']);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(el);
  });

  it('skips selectors that match nothing', () => {
    const el = document.createElement('article');
    el.id = 'fpe-article';
    container.appendChild(el);
    const result = findPickedElements(['#fpe-article', '#does-not-exist']);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(el);
  });

  it('skips falsy entries inside the array', () => {
    const el = document.createElement('p');
    el.id = 'fpe-para';
    container.appendChild(el);
    const result = findPickedElements([null, '', '#fpe-para', undefined]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(el);
  });

  it('silently skips invalid CSS selectors', () => {
    const result = findPickedElements(['[[[invalid', '#fpe-fixture']);
    // invalid selector skipped; valid one still returns the fixture
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(container);
  });

  it('returns multiple elements when multiple selectors each match', () => {
    const a = document.createElement('span');
    a.id = 'fpe-a';
    const b = document.createElement('span');
    b.id = 'fpe-b';
    container.append(a, b);
    const result = findPickedElements(['#fpe-a', '#fpe-b']);
    expect(result).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// assessRecordForRail
// ---------------------------------------------------------------------------

describe('assessRecordForRail', () => {
  it('returns not_found for null', () => {
    expect(assessRecordForRail(null)).toEqual({ kind: 'not_found' });
  });

  it('returns not_found for undefined', () => {
    expect(assessRecordForRail(undefined)).toEqual({ kind: 'not_found' });
  });

  it('returns error for status=error', () => {
    const record = { key: 'k', status: 'error', error: 'oops' };
    const result = assessRecordForRail(record);
    expect(result.kind).toBe('error');
    expect(result.record).toBe(record);
  });

  it('returns needs_attention for a parked record (not in_progress)', () => {
    const record = {
      key: 'k',
      status: 'needs_attention',
      progress: { stage: 'needs_attention' },
      summaryErrors: [{ topic: 'Tech>AI', error_kind: 'timeout' }],
    };
    const result = assessRecordForRail(record);
    expect(result.kind).toBe('needs_attention');
    expect(result.record).toBe(record);
  });

  it('returns in_progress with stage from progress.stage when status is queued', () => {
    const record = { key: 'k', status: 'queued', progress: { stage: 'tokenising' } };
    const result = assessRecordForRail(record);
    expect(result.kind).toBe('in_progress');
    expect(result.stage).toBe('tokenising');
  });

  it('returns in_progress using status as stage when progress is absent', () => {
    const record = { key: 'k', status: 'processing' };
    const result = assessRecordForRail(record);
    expect(result.kind).toBe('in_progress');
    expect(result.stage).toBe('processing');
  });

  it('returns in_progress with stage "queued" when status is unknown and no progress', () => {
    const record = { key: 'k', status: 'pending' };
    const result = assessRecordForRail(record);
    expect(result.kind).toBe('in_progress');
    expect(result.stage).toBe('pending');
  });

  it('returns no_selectors for done record with missing selectors field', () => {
    const record = { key: 'k', status: 'done' };
    const result = assessRecordForRail(record);
    expect(result.kind).toBe('no_selectors');
    expect(result.record).toBe(record);
  });

  it('returns no_selectors for done record with empty selectors array', () => {
    const record = { key: 'k', status: 'done', selectors: [] };
    const result = assessRecordForRail(record);
    expect(result.kind).toBe('no_selectors');
  });

  it('returns no_selectors for done record with non-array selectors', () => {
    const record = { key: 'k', status: 'done', selectors: 'body' };
    const result = assessRecordForRail(record);
    expect(result.kind).toBe('no_selectors');
  });

  it('returns ready for done record with non-empty selectors', () => {
    const record = { key: 'k', status: 'done', selectors: ['body > main'] };
    const result = assessRecordForRail(record);
    expect(result.kind).toBe('ready');
    expect(result.record).toBe(record);
  });
});

// ---------------------------------------------------------------------------
// createLoadToken
// ---------------------------------------------------------------------------

describe('createLoadToken', () => {
  it('sets tokenHolder.current to a unique symbol', () => {
    const holder = { current: null };
    const guard = createLoadToken(holder);
    expect(typeof holder.current).toBe('symbol');
    expect(holder.current).toBe(guard.token);
  });

  it('isStale() returns false immediately after creation', () => {
    const holder = { current: null };
    const guard = createLoadToken(holder);
    expect(guard.isStale()).toBe(false);
  });

  it('isStale() returns true when holder is nullified (closeInPageRail path)', () => {
    const holder = { current: null };
    const guard = createLoadToken(holder);
    // Simulate closeInPageRail setting the holder to null
    holder.current = null;
    expect(guard.isStale()).toBe(true);
  });

  it('isStale() returns true when a newer token overwrites the holder', () => {
    const holder = { current: null };
    const guard1 = createLoadToken(holder);
    // A second call overwrites holder.current
    createLoadToken(holder);
    expect(guard1.isStale()).toBe(true);
  });

  it('the newer guard isStale() returns false while the older one returns true', () => {
    const holder = { current: null };
    const guard1 = createLoadToken(holder);
    const guard2 = createLoadToken(holder);
    expect(guard1.isStale()).toBe(true);
    expect(guard2.isStale()).toBe(false);
  });

  it('each call produces a distinct token symbol', () => {
    const holder = { current: null };
    const guard1 = createLoadToken(holder);
    const t1 = guard1.token;
    const guard2 = createLoadToken(holder);
    const t2 = guard2.token;
    expect(t1).not.toBe(t2);
  });
});
