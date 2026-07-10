// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  DEFAULT_VERBOSE_LOGS,
  VERBOSE_LOGS_KEY,
  getStoredVerboseLogs,
  normalizeVerboseLogs,
  setStoredVerboseLogs,
} from './verboseLogSettings.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('verbose log settings', () => {
  it('normalizes only strict true to true', () => {
    expect(normalizeVerboseLogs(true)).toBe(true);
    expect(normalizeVerboseLogs(false)).toBe(false);
    expect(normalizeVerboseLogs(undefined)).toBe(false);
    expect(normalizeVerboseLogs('true')).toBe(false);
    expect(normalizeVerboseLogs(1)).toBe(false);
  });

  it('defaults to off', () => {
    expect(DEFAULT_VERBOSE_LOGS).toBe(false);
  });

  it('reads stored preference with normalization and fallback paths', async () => {
    vi.stubGlobal('chrome', {
      runtime: {},
      storage: {
        local: {
          get: vi.fn((key, cb) => cb({ [key]: true })),
        },
      },
    });
    await expect(getStoredVerboseLogs()).resolves.toBe(true);

    chrome.storage.local.get = vi.fn((key, cb) => cb({ [key]: 'yes' }));
    await expect(getStoredVerboseLogs()).resolves.toBe(false);

    chrome.runtime.lastError = { message: 'read failed' };
    await expect(getStoredVerboseLogs()).resolves.toBe(DEFAULT_VERBOSE_LOGS);

    chrome.storage.local.get = vi.fn(() => {
      throw new Error('missing storage');
    });
    await expect(getStoredVerboseLogs()).resolves.toBe(DEFAULT_VERBOSE_LOGS);
  });

  it('writes stored preference and rejects storage failures', async () => {
    vi.stubGlobal('chrome', {
      runtime: {},
      storage: {
        local: {
          set: vi.fn((items, cb) => cb()),
        },
      },
    });

    await expect(setStoredVerboseLogs(true)).resolves.toBe(true);
    expect(chrome.storage.local.set).toHaveBeenCalledWith(
      { [VERBOSE_LOGS_KEY]: true },
      expect.any(Function),
    );

    // Non-true values are normalized before persisting.
    await expect(setStoredVerboseLogs('yes')).resolves.toBe(false);
    expect(chrome.storage.local.set).toHaveBeenLastCalledWith(
      { [VERBOSE_LOGS_KEY]: false },
      expect.any(Function),
    );

    chrome.runtime.lastError = { message: 'write failed' };
    await expect(setStoredVerboseLogs(true)).rejects.toThrow('write failed');

    chrome.runtime.lastError = null;
    chrome.storage.local.set = vi.fn(() => {
      throw 'boom';
    });
    await expect(setStoredVerboseLogs(true)).rejects.toThrow('boom');
  });
});
