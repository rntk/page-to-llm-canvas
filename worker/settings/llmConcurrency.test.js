// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MAX_PARALLEL_LLM_REQUESTS,
  MAX_PARALLEL_LLM_REQUESTS,
  MAX_PARALLEL_LLM_REQUESTS_KEY,
  MIN_PARALLEL_LLM_REQUESTS,
  getStoredMaxParallelLlmRequests,
  normalizeMaxParallelLlmRequests,
  setStoredMaxParallelLlmRequests,
} from './llmConcurrency.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('LLM concurrency settings', () => {
  it('normalizes integers and clamps values to the supported range', () => {
    expect(normalizeMaxParallelLlmRequests('6')).toBe(6);
    expect(normalizeMaxParallelLlmRequests(3.9)).toBe(3);
    expect(normalizeMaxParallelLlmRequests(0)).toBe(MIN_PARALLEL_LLM_REQUESTS);
    expect(normalizeMaxParallelLlmRequests(999)).toBe(MAX_PARALLEL_LLM_REQUESTS);
    expect(normalizeMaxParallelLlmRequests('invalid')).toBe(DEFAULT_MAX_PARALLEL_LLM_REQUESTS);
  });

  it('reads the stored limit and falls back when storage fails', async () => {
    vi.stubGlobal('chrome', {
      runtime: {},
      storage: {
        local: {
          get: vi.fn((key, callback) => callback({ [key]: 7 })),
        },
      },
    });

    await expect(getStoredMaxParallelLlmRequests()).resolves.toBe(7);

    chrome.runtime.lastError = { message: 'read failed' };
    await expect(getStoredMaxParallelLlmRequests()).resolves.toBe(
      DEFAULT_MAX_PARALLEL_LLM_REQUESTS,
    );

    chrome.storage.local.get = vi.fn(() => {
      throw new Error('storage unavailable');
    });
    await expect(getStoredMaxParallelLlmRequests()).resolves.toBe(
      DEFAULT_MAX_PARALLEL_LLM_REQUESTS,
    );
  });

  it('persists the normalized limit and surfaces write failures', async () => {
    vi.stubGlobal('chrome', {
      runtime: {},
      storage: {
        local: {
          set: vi.fn((_items, callback) => callback()),
        },
      },
    });

    await expect(setStoredMaxParallelLlmRequests('8')).resolves.toBe(8);
    expect(chrome.storage.local.set).toHaveBeenCalledWith(
      { [MAX_PARALLEL_LLM_REQUESTS_KEY]: 8 },
      expect.any(Function),
    );

    chrome.runtime.lastError = { message: 'write failed' };
    await expect(setStoredMaxParallelLlmRequests(3)).rejects.toThrow('write failed');
  });
});
