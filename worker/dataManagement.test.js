import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAllExtensionData, getStorageOverview } from './dataManagement.js';
import { _resetUpdateQueues } from './storage.js';

function makeChromeMock(initial = {}) {
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
      'pagetollm-llm-metrics': { totalCount: 1 },
      'old-extension-key': { legacy: true },
    });
    vi.stubGlobal('chrome', mock);

    const overview = await getStorageOverview();

    expect(overview.totalKeyCount).toBe(10);
    expect(overview.categories.pageData).toMatchObject({
      keyCount: 5,
      recordCount: 1,
      chatCount: 1,
    });
    expect(overview.categories.providers).toMatchObject({ keyCount: 1, providerCount: 1 });
    expect(overview.categories.settings.keyCount).toBe(2);
    expect(overview.categories.diagnostics.keyCount).toBe(1);
    expect(overview.categories.other.keyCount).toBe(1);
    expect(JSON.stringify(overview)).not.toContain('secret');
    expect(JSON.stringify(overview)).not.toContain('private page text');
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
