import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_VERBOSE_LOGS,
  VERBOSE_LOGS_KEY,
  getStoredVerboseLogs,
  normalizeVerboseLogs,
  setStoredVerboseLogs,
} from './verboseLogSettings.js';

function installChrome({
  get = (_key, callback) => callback({}),
  set = (_items, callback) => callback(),
  lastError = null,
} = {}) {
  const runtime = { lastError };
  const local = { get: vi.fn(get), set: vi.fn(set) };
  vi.stubGlobal('chrome', { runtime, storage: { local } });
  return { local, runtime };
}

describe('verbose log settings', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('normalizes only the boolean true value to enabled', () => {
    expect(normalizeVerboseLogs(true)).toBe(true);
    for (const value of [false, undefined, null, 1, 'true', {}]) {
      expect(normalizeVerboseLogs(value)).toBe(false);
    }
  });

  it('reads and normalizes the stored setting', async () => {
    const { local } = installChrome({
      get: (_key, callback) => callback({ [VERBOSE_LOGS_KEY]: true }),
    });
    await expect(getStoredVerboseLogs()).resolves.toBe(true);
    expect(local.get).toHaveBeenCalledWith(VERBOSE_LOGS_KEY, expect.any(Function));

    installChrome({ get: (_key, callback) => callback({ [VERBOSE_LOGS_KEY]: 'true' }) });
    await expect(getStoredVerboseLogs()).resolves.toBe(DEFAULT_VERBOSE_LOGS);
  });

  it('falls back to disabled when get reports an error or throws', async () => {
    const { runtime } = installChrome({
      get: (_key, callback) => callback({ [VERBOSE_LOGS_KEY]: true }),
    });
    runtime.lastError = { message: 'read failed' };
    await expect(getStoredVerboseLogs()).resolves.toBe(false);

    installChrome({
      get: () => {
        throw new Error('read threw');
      },
    });
    await expect(getStoredVerboseLogs()).resolves.toBe(false);
  });

  it('stores the normalized value and resolves with it', async () => {
    const { local } = installChrome();
    await expect(setStoredVerboseLogs('true')).resolves.toBe(false);
    await expect(setStoredVerboseLogs(true)).resolves.toBe(true);
    expect(local.set).toHaveBeenLastCalledWith({ [VERBOSE_LOGS_KEY]: true }, expect.any(Function));
  });

  it('rejects set failures with Chrome and synchronous errors', async () => {
    const { runtime } = installChrome();
    runtime.lastError = { message: 'write failed' };
    await expect(setStoredVerboseLogs(true)).rejects.toThrow('write failed');

    installChrome({
      set: () => {
        throw new Error('write threw');
      },
    });
    await expect(setStoredVerboseLogs(true)).rejects.toThrow('write threw');

    installChrome({
      set: () => {
        throw 'non-error';
      },
    });
    await expect(setStoredVerboseLogs(true)).rejects.toThrow('non-error');
  });
});
