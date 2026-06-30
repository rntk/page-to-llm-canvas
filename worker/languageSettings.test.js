// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  DEFAULT_PREFER_CONTENT_LANGUAGE,
  PREFER_CONTENT_LANGUAGE_KEY,
  getStoredPreferContentLanguage,
  normalizePreferContentLanguage,
  setStoredPreferContentLanguage,
} from './languageSettings.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('language settings', () => {
  it('normalizes only strict true to true', () => {
    expect(normalizePreferContentLanguage(true)).toBe(true);
    expect(normalizePreferContentLanguage(false)).toBe(false);
    expect(normalizePreferContentLanguage(undefined)).toBe(false);
    expect(normalizePreferContentLanguage('true')).toBe(false);
    expect(normalizePreferContentLanguage(1)).toBe(false);
  });

  it('defaults to off', () => {
    expect(DEFAULT_PREFER_CONTENT_LANGUAGE).toBe(false);
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
    await expect(getStoredPreferContentLanguage()).resolves.toBe(true);

    chrome.storage.local.get = vi.fn((key, cb) => cb({ [key]: 'yes' }));
    await expect(getStoredPreferContentLanguage()).resolves.toBe(false);

    chrome.runtime.lastError = { message: 'read failed' };
    await expect(getStoredPreferContentLanguage()).resolves.toBe(DEFAULT_PREFER_CONTENT_LANGUAGE);

    chrome.storage.local.get = vi.fn(() => {
      throw new Error('missing storage');
    });
    await expect(getStoredPreferContentLanguage()).resolves.toBe(DEFAULT_PREFER_CONTENT_LANGUAGE);
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

    await expect(setStoredPreferContentLanguage(true)).resolves.toBe(true);
    expect(chrome.storage.local.set).toHaveBeenCalledWith(
      { [PREFER_CONTENT_LANGUAGE_KEY]: true },
      expect.any(Function),
    );

    // Non-true values are normalized before persisting.
    await expect(setStoredPreferContentLanguage('yes')).resolves.toBe(false);
    expect(chrome.storage.local.set).toHaveBeenLastCalledWith(
      { [PREFER_CONTENT_LANGUAGE_KEY]: false },
      expect.any(Function),
    );

    chrome.runtime.lastError = { message: 'write failed' };
    await expect(setStoredPreferContentLanguage(true)).rejects.toThrow('write failed');

    chrome.runtime.lastError = null;
    chrome.storage.local.set = vi.fn(() => {
      throw 'boom';
    });
    await expect(setStoredPreferContentLanguage(true)).rejects.toThrow('boom');
  });
});
