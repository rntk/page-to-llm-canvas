// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_LLM_REQUEST_TIMEOUT_SECONDS,
  LLM_REQUEST_TIMEOUT_SECONDS_KEY,
  MAX_LLM_REQUEST_TIMEOUT_SECONDS,
  MIN_LLM_REQUEST_TIMEOUT_SECONDS,
  getStoredLlmRequestTimeoutSeconds,
  normalizeLlmRequestTimeoutSeconds,
  setStoredLlmRequestTimeoutSeconds,
} from './llmTimeout.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('LLM request timeout settings', () => {
  it('normalizes integers and clamps values to the supported range', () => {
    expect(normalizeLlmRequestTimeoutSeconds('600')).toBe(600);
    expect(normalizeLlmRequestTimeoutSeconds(30.9)).toBe(30);
    expect(normalizeLlmRequestTimeoutSeconds(0)).toBe(MIN_LLM_REQUEST_TIMEOUT_SECONDS);
    expect(normalizeLlmRequestTimeoutSeconds(Number.MAX_SAFE_INTEGER)).toBe(
      MAX_LLM_REQUEST_TIMEOUT_SECONDS,
    );
    expect(normalizeLlmRequestTimeoutSeconds('invalid')).toBe(DEFAULT_LLM_REQUEST_TIMEOUT_SECONDS);
  });

  it('reads the stored timeout and falls back when storage fails', async () => {
    vi.stubGlobal('chrome', {
      runtime: {},
      storage: {
        local: {
          get: vi.fn((key, callback) => callback({ [key]: 900 })),
        },
      },
    });

    await expect(getStoredLlmRequestTimeoutSeconds()).resolves.toBe(900);

    chrome.runtime.lastError = { message: 'read failed' };
    await expect(getStoredLlmRequestTimeoutSeconds()).resolves.toBe(
      DEFAULT_LLM_REQUEST_TIMEOUT_SECONDS,
    );

    chrome.storage.local.get = vi.fn(() => {
      throw new Error('storage unavailable');
    });
    await expect(getStoredLlmRequestTimeoutSeconds()).resolves.toBe(
      DEFAULT_LLM_REQUEST_TIMEOUT_SECONDS,
    );
  });

  it('persists the normalized timeout and surfaces write failures', async () => {
    vi.stubGlobal('chrome', {
      runtime: {},
      storage: {
        local: {
          set: vi.fn((_items, callback) => callback()),
        },
      },
    });

    await expect(setStoredLlmRequestTimeoutSeconds('300')).resolves.toBe(300);
    expect(chrome.storage.local.set).toHaveBeenCalledWith(
      { [LLM_REQUEST_TIMEOUT_SECONDS_KEY]: 300 },
      expect.any(Function),
    );

    chrome.runtime.lastError = { message: 'write failed' };
    await expect(setStoredLlmRequestTimeoutSeconds(60)).rejects.toThrow('write failed');
  });
});
