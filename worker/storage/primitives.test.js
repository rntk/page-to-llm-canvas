import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MUTATION_QUEUE_KEY,
  clearLocal,
  getLocal,
  getLocalByPrefix,
  getLocalKeysByPrefix,
  queuedUpdate,
  removeLocal,
  resetUpdateQueues,
  setLocal,
} from './primitives.js';

function installChrome({ items = {}, getKeys, lastError = null } = {}) {
  const runtime = { lastError };
  const local = {
    get: vi.fn((keys, callback) => {
      if (keys === null) callback({ ...items });
      else if (Array.isArray(keys))
        callback(
          Object.fromEntries(keys.filter((key) => key in items).map((key) => [key, items[key]])),
        );
      else callback({ [keys]: items[keys] });
    }),
    getKeys: getKeys === undefined ? undefined : vi.fn(getKeys),
    set: vi.fn((_newItems, callback) => callback()),
    remove: vi.fn((_keys, callback) => callback()),
    clear: vi.fn((callback) => callback()),
  };
  vi.stubGlobal('chrome', { runtime, storage: { local } });
  return { local, runtime };
}

describe('storage primitives', () => {
  beforeEach(() => {
    resetUpdateQueues();
    vi.restoreAllMocks();
  });

  it('reads local values and defaults an empty callback result to an object', async () => {
    const { local } = installChrome();
    await expect(getLocal('missing')).resolves.toEqual({ missing: undefined });
    local.get.mockImplementationOnce((_keys, callback) => callback(undefined));
    await expect(getLocal(null)).resolves.toEqual({});
  });

  it('rejects get, set, remove, and clear when Chrome reports an error', async () => {
    const { runtime } = installChrome();
    runtime.lastError = { message: 'storage failed' };
    await expect(getLocal(null)).rejects.toThrow('storage failed');
    await expect(setLocal({ key: 'value' })).rejects.toThrow('storage failed');
    await expect(removeLocal('key')).rejects.toThrow('storage failed');
    await expect(clearLocal()).rejects.toThrow('storage failed');
  });

  it('uses getKeys when available and only reads matching keys', async () => {
    const { local } = installChrome({
      items: { 'pagetollm:a': 1, 'pagetollm:b': 2, unrelated: 3 },
      getKeys: () => Promise.resolve(['pagetollm:a', 'unrelated', 'pagetollm:b']),
    });
    await expect(getLocalByPrefix('pagetollm:')).resolves.toEqual({
      'pagetollm:a': 1,
      'pagetollm:b': 2,
    });
    expect(local.getKeys).toHaveBeenCalledOnce();
    expect(local.get).toHaveBeenCalledWith(['pagetollm:a', 'pagetollm:b'], expect.any(Function));
  });

  it('returns an empty object without reading when getKeys finds no matches', async () => {
    const { local } = installChrome({ getKeys: () => Promise.resolve(['other']) });
    await expect(getLocalByPrefix('pagetollm:')).resolves.toEqual({});
    expect(local.get).not.toHaveBeenCalled();
  });

  it('lists matching keys without loading their values', async () => {
    const { local } = installChrome({
      items: { 'prefix:large': { html: 'large' }, other: 2 },
      getKeys: () => Promise.resolve(['prefix:large', 'other']),
    });
    await expect(getLocalKeysByPrefix('prefix:')).resolves.toEqual(['prefix:large']);
    expect(local.getKeys).toHaveBeenCalledOnce();
    expect(local.get).not.toHaveBeenCalled();
  });

  it('falls back to a full read when getKeys is unavailable', async () => {
    const { local } = installChrome({ items: { 'prefix:one': 1, other: 2 } });
    await expect(getLocalByPrefix('prefix:')).resolves.toEqual({ 'prefix:one': 1 });
    expect(local.get).toHaveBeenCalledWith(null, expect.any(Function));
  });

  it('rejects getKeys errors and treats a non-array key result as empty', async () => {
    installChrome({ getKeys: () => Promise.reject(new Error('getKeys failed')) });
    await expect(getLocalByPrefix('prefix:')).rejects.toThrow('getKeys failed');

    const { local } = installChrome({ getKeys: () => Promise.resolve(null) });
    await expect(getLocalByPrefix('prefix:')).resolves.toEqual({});
    expect(local.get).not.toHaveBeenCalled();
  });

  it('falls back to the callback form when getKeys returns no promise', async () => {
    const { local, runtime } = installChrome({
      items: { 'prefix:one': 1, other: 2 },
      getKeys: (callback) => {
        if (typeof callback !== 'function') throw new TypeError('No matching signature');
        callback(['prefix:one', 'other']);
      },
    });
    await expect(getLocalByPrefix('prefix:')).resolves.toEqual({ 'prefix:one': 1 });
    expect(local.get).toHaveBeenCalledWith(['prefix:one'], expect.any(Function));

    runtime.lastError = { message: 'getKeys failed' };
    await expect(getLocalByPrefix('prefix:')).rejects.toThrow('getKeys failed');
  });

  it('serializes updates per key while allowing different keys to run independently', async () => {
    const events = [];
    let release;
    const first = queuedUpdate('record', async () => {
      events.push('first:start');
      await new Promise((resolve) => {
        release = resolve;
      });
      events.push('first:end');
      return 'first';
    });
    const second = queuedUpdate('record', async () => {
      events.push('second');
      return 'second';
    });
    const other = queuedUpdate('other', async () => {
      events.push('other');
      return 'other';
    });
    await other;
    expect(events).toEqual(['first:start', 'other']);
    release();
    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toBe('second');
    expect(events).toEqual(['first:start', 'other', 'first:end', 'second']);
  });

  it('recovers after a failed update and prunes idle queues', async () => {
    const failure = queuedUpdate('record', async () => {
      throw new Error('expected');
    });
    await expect(failure).rejects.toThrow('expected');
    await expect(queuedUpdate('record', async () => 'recovered')).resolves.toBe('recovered');
    await expect(queuedUpdate(MUTATION_QUEUE_KEY, async () => 'queue-key')).resolves.toBe(
      'queue-key',
    );
    resetUpdateQueues();
    await expect(queuedUpdate('record', async () => 'after-reset')).resolves.toBe('after-reset');
  });
});
