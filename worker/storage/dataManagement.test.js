import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAllExtensionData, getStorageOverview } from './dataManagement.js';
import { _resetUpdateQueues } from './storage.js';

/**
 * @param {object} initial Seed contents.
 * @param {{getKeys?: boolean, getBytesInUse?: boolean}} [caps] Which optional
 *   storage APIs this browser exposes; both are absent by default so the
 *   legacy fallback paths stay covered.
 */
function makeChromeMock(initial = {}, caps = {}) {
  const store = new Map(Object.entries(initial));
  const runtime = { lastError: null };
  const local = {
    get: vi.fn((keys, callback) => {
      const selected = keys == null ? [...store.keys()] : Array.isArray(keys) ? keys : [keys];
      callback(
        Object.fromEntries(
          selected.filter((key) => store.has(key)).map((key) => [key, store.get(key)]),
        ),
      );
    }),
    set: vi.fn((items, callback) => {
      for (const [key, value] of Object.entries(items)) store.set(key, value);
      callback();
    }),
    remove: vi.fn((keys, callback) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) store.delete(key);
      callback();
    }),
    clear: vi.fn((callback) => {
      store.clear();
      callback();
    }),
  };
  if (caps.getKeys) local.getKeys = vi.fn(() => Promise.resolve([...store.keys()]));
  if (caps.getBytesInUse) {
    local.getBytesInUse = vi.fn((keys, callback) => callback(keys.length * 100));
  }
  return { storage: { local }, runtime, store };
}

beforeEach(() => {
  _resetUpdateQueues();
});

describe('extension data management', () => {
  it('reports every stored key in a privacy-safe category', async () => {
    const mock = makeChromeMock({
      'pagetollm:index': { keys: ['page'] },
      'pagetollm:rec:page:meta': { key: 'page' },
      'pagetollm:rec:page:content': { text: 'private page text' },
      'pagetollm:chats:page:index': { chats: [] },
      'pagetollm:chats:page:chat_1': { messages: [{ content: 'private chat' }] },
      'pagetollm:llm:providers': { providers: [{ token: 'secret' }] },
      'pagetollm-theme': 'dark',
      'pagetollm-max-parallel-llm-requests': 3,
      'pagetollm-llm-request-timeout-seconds': 600,
      'pagetollm-llm-metrics': { totalCount: 1 },
      'old-extension-key': { legacy: true },
    });
    vi.stubGlobal('chrome', mock);

    const overview = await getStorageOverview();

    expect(overview.totalKeyCount).toBe(11);
    expect(overview.categories.pageData).toMatchObject({
      keyCount: 5,
      recordCount: 1,
      chatCount: 1,
    });
    expect(overview.categories.providers).toMatchObject({ keyCount: 1, providerCount: 1 });
    expect(overview.categories.settings.keyCount).toBe(3);
    expect(overview.categories.diagnostics.keyCount).toBe(1);
    expect(overview.categories.other.keyCount).toBe(1);
    expect(JSON.stringify(overview)).not.toContain('secret');
    expect(JSON.stringify(overview)).not.toContain('private page text');
  });

  it('never deserializes whole-store values when the browser can list keys', async () => {
    const mock = makeChromeMock(
      {
        'pagetollm:index': { keys: ['page'] },
        'pagetollm:rec:page:meta': { key: 'page' },
        'pagetollm:rec:page:content': { text: 'private page text' },
        'pagetollm:llm:providers': { providers: [{ token: 'secret' }, { token: 'second' }] },
        'pagetollm-theme': 'dark',
      },
      { getKeys: true, getBytesInUse: true },
    );
    vi.stubGlobal('chrome', mock);

    const overview = await getStorageOverview();

    expect(overview.totalKeyCount).toBe(5);
    expect(overview.approximate).toBe(false);
    expect(overview.categories.providers.providerCount).toBe(2);
    // The provider record is the only value read, and no call asks for
    // everything at once.
    expect(mock.storage.local.get).toHaveBeenCalledTimes(1);
    expect(mock.storage.local.get).toHaveBeenCalledWith(
      'pagetollm:llm:providers',
      expect.any(Function),
    );
  });

  it('estimates sizes in batches when getBytesInUse is unavailable', async () => {
    const initial = {};
    for (let i = 0; i < 45; i += 1) initial[`pagetollm:rec:page${i}:meta`] = { key: `page${i}` };
    const mock = makeChromeMock(initial, { getKeys: true });
    vi.stubGlobal('chrome', mock);

    const overview = await getStorageOverview();

    expect(overview.approximate).toBe(true);
    expect(overview.partial).toBe(false);
    expect(overview.categories.pageData.bytes).toBeGreaterThan(0);
    // 45 keys read in batches of 20, never in one whole-store read.
    expect(mock.storage.local.get).toHaveBeenCalledTimes(3);
    for (const [keys] of mock.storage.local.get.mock.calls) {
      expect(Array.isArray(keys)).toBe(true);
      expect(keys.length).toBeLessThanOrEqual(20);
    }
  });

  it('marks a category whose size estimate lost a batch as a lower bound', async () => {
    const initial = {};
    for (let i = 0; i < 45; i += 1) initial[`pagetollm:rec:page${i}:meta`] = { key: `page${i}` };
    const mock = makeChromeMock(initial, { getKeys: true });
    const passthrough = mock.storage.local.get.getMockImplementation();
    let reads = 0;
    mock.storage.local.get.mockImplementation((keys, callback) => {
      reads += 1;
      if (reads === 2) {
        // One transient read failure mid-estimate: the surviving batches still
        // contribute, so the total is real but incomplete.
        mock.runtime.lastError = { message: 'storage read failed' };
        callback(undefined);
        mock.runtime.lastError = null;
        return;
      }
      passthrough(keys, callback);
    });
    vi.stubGlobal('chrome', mock);

    const overview = await getStorageOverview();

    expect(overview.partial).toBe(true);
    expect(overview.categories.pageData.partial).toBe(true);
    // Not zeroed out: the batches that did read still count toward the bound.
    expect(overview.categories.pageData.bytes).toBeGreaterThan(0);
    expect(overview.categories.pageData.keyCount).toBe(45);
    // Categories that read cleanly are not tainted by another's failure.
    expect(overview.categories.settings.partial).toBe(false);
  });

  it('removes known and unknown local data in one authoritative clear', async () => {
    const mock = makeChromeMock({
      'pagetollm:rec:page:content': { text: 'page' },
      'pagetollm:llm:providers': { providers: [] },
      'unknown-key': true,
    });
    vi.stubGlobal('chrome', mock);

    await clearAllExtensionData();

    expect(mock.storage.local.clear).toHaveBeenCalledTimes(1);
    expect(mock.store.size).toBe(0);
  });
});
