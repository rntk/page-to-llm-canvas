import { vi } from 'vitest';

const DEFAULT_INDEX_KEY = 'pagetollm:index';

/**
 * Builds an in-memory fake of chrome.storage.local.
 *
 * The returned `_state` object stays mutable so a test can seed data before
 * enabling a failure. Set failures can target every write, a numbered write,
 * or only writes containing the configured index key.
 *
 * @param {{
 *   lastErrorOnSet?: boolean,
 *   lastErrorOnGet?: boolean,
 *   lastErrorOnRemove?: boolean,
 *   setDelay?: number,
 *   failSetOnCall?: number,
 *   failIndexSet?: boolean,
 *   indexKey?: string,
 * }} [opts]
 * @returns {object}
 */
export function createChromeStorageFake(opts = {}) {
  const state = {
    lastErrorOnSet: false,
    lastErrorOnGet: false,
    lastErrorOnRemove: false,
    setDelay: 0,
    failSetOnCall: 0,
    failIndexSet: false,
    indexKey: DEFAULT_INDEX_KEY,
    ...opts,
  };
  const store = new Map();
  const runtime = { lastError: null };
  let setCalls = 0;

  const local = {
    _store: store,
    // Promise-only, matching Chrome 130+: a callback passed here is ignored.
    getKeys: vi.fn(() => {
      runtime.lastError = null;
      return Promise.resolve([...store.keys()]);
    }),
    get: vi.fn((keys, callback) => {
      if (state.lastErrorOnGet) {
        runtime.lastError = { message: 'get failed' };
        callback({});
        runtime.lastError = null;
        return;
      }

      runtime.lastError = null;
      const result = {};
      const keyList =
        keys === null || keys === undefined
          ? [...store.keys()]
          : Array.isArray(keys)
            ? keys
            : [keys];
      for (const key of keyList) {
        if (store.has(key)) result[key] = store.get(key);
      }
      callback(result);
    }),
    set: vi.fn((items, callback) => {
      const setItems = () => {
        setCalls += 1;
        if (
          state.lastErrorOnSet ||
          setCalls === state.failSetOnCall ||
          (state.failIndexSet && Object.hasOwn(items, state.indexKey))
        ) {
          runtime.lastError = { message: 'QuotaExceededError' };
          callback();
          runtime.lastError = null;
          return;
        }

        runtime.lastError = null;
        for (const [key, value] of Object.entries(items)) store.set(key, value);
        callback();
      };

      if (state.setDelay > 0) setTimeout(setItems, state.setDelay);
      else setItems();
    }),
    remove: vi.fn((keys, callback) => {
      if (state.lastErrorOnRemove) {
        runtime.lastError = { message: 'remove failed' };
        callback();
        runtime.lastError = null;
        return;
      }

      runtime.lastError = null;
      const keyList = Array.isArray(keys) ? keys : [keys];
      for (const key of keyList) store.delete(key);
      callback();
    }),
  };

  return { storage: { local }, runtime, _state: state };
}

/**
 * Creates the default storage record shared by storage-related tests.
 *
 * @param {string} key Record key.
 * @param {object} [overrides] Record fields to replace or add.
 * @returns {object}
 */
export function createStorageRecord(key, overrides = {}) {
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
