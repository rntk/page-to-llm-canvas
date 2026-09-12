// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  DEFAULT_SUMMARIES_DISABLED,
  SUMMARIES_DISABLED_KEY,
  getStoredSummariesDisabled,
  normalizeSummariesDisabled,
  setStoredSummariesDisabled,
} from './summary.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('summary settings', () => {
  it('normalizes only strict true to true', () => {
    expect(normalizeSummariesDisabled(true)).toBe(true);
    expect(normalizeSummariesDisabled(false)).toBe(false);
    expect(normalizeSummariesDisabled(undefined)).toBe(false);
    expect(normalizeSummariesDisabled('true')).toBe(false);
    expect(normalizeSummariesDisabled(1)).toBe(false);
  });

  it('defaults to off', () => {
    expect(DEFAULT_SUMMARIES_DISABLED).toBe(false);
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
    await expect(getStoredSummariesDisabled()).resolves.toBe(true);

    chrome.storage.local.get = vi.fn((key, cb) => cb({ [key]: 'yes' }));
    await expect(getStoredSummariesDisabled()).resolves.toBe(false);

    chrome.runtime.lastError = { message: 'read failed' };
    await expect(getStoredSummariesDisabled()).resolves.toBe(DEFAULT_SUMMARIES_DISABLED);

    chrome.storage.local.get = vi.fn(() => {
      throw new Error('missing storage');
    });
    await expect(getStoredSummariesDisabled()).resolves.toBe(DEFAULT_SUMMARIES_DISABLED);
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

    await expect(setStoredSummariesDisabled(true)).resolves.toBe(true);
    expect(chrome.storage.local.set).toHaveBeenCalledWith(
      { [SUMMARIES_DISABLED_KEY]: true },
      expect.any(Function),
    );

    // Non-true values are normalized before persisting.
    await expect(setStoredSummariesDisabled('yes')).resolves.toBe(false);
    expect(chrome.storage.local.set).toHaveBeenLastCalledWith(
      { [SUMMARIES_DISABLED_KEY]: false },
      expect.any(Function),
    );

    chrome.runtime.lastError = { message: 'write failed' };
    await expect(setStoredSummariesDisabled(true)).rejects.toThrow('write failed');

    chrome.runtime.lastError = null;
    chrome.storage.local.set = vi.fn(() => {
      throw 'boom';
    });
    await expect(setStoredSummariesDisabled(true)).rejects.toThrow('boom');
  });
});
