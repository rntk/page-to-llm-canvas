// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PREFER_CONTENT_LANGUAGE,
  PREFER_CONTENT_LANGUAGE_KEY,
  getStoredPreferContentLanguage,
  normalizePreferContentLanguage,
  setStoredPreferContentLanguage,
} from './language.js';
import {
  DEFAULT_SUMMARIES_DISABLED,
  SUMMARIES_DISABLED_KEY,
  getStoredSummariesDisabled,
  normalizeSummariesDisabled,
  setStoredSummariesDisabled,
} from './summary.js';
import {
  DEFAULT_MAX_PARALLEL_LLM_REQUESTS,
  MAX_PARALLEL_LLM_REQUESTS,
  MAX_PARALLEL_LLM_REQUESTS_KEY,
  MIN_PARALLEL_LLM_REQUESTS,
  normalizeMaxParallelLlmRequests,
  getStoredMaxParallelLlmRequests,
  setStoredMaxParallelLlmRequests,
} from './llmConcurrency.js';
import {
  DEFAULT_LLM_REQUEST_TIMEOUT_SECONDS,
  LLM_REQUEST_TIMEOUT_SECONDS_KEY,
  MAX_LLM_REQUEST_TIMEOUT_SECONDS,
  MIN_LLM_REQUEST_TIMEOUT_SECONDS,
  normalizeLlmRequestTimeoutSeconds,
  getStoredLlmRequestTimeoutSeconds,
  setStoredLlmRequestTimeoutSeconds,
} from './llmTimeout.js';

afterEach(() => vi.unstubAllGlobals());

const settings = [
  {
    name: 'content language',
    key: PREFER_CONTENT_LANGUAGE_KEY,
    fallback: DEFAULT_PREFER_CONTENT_LANGUAGE,
    normalize: normalizePreferContentLanguage,
    get: getStoredPreferContentLanguage,
    set: setStoredPreferContentLanguage,
    value: true,
    invalid: 'yes',
    normalizedInvalid: false,
    cases: [
      [false, false],
      [undefined, false],
      ['true', false],
      [1, false],
    ],
  },
  {
    name: 'summaries disabled',
    key: SUMMARIES_DISABLED_KEY,
    fallback: DEFAULT_SUMMARIES_DISABLED,
    normalize: normalizeSummariesDisabled,
    get: getStoredSummariesDisabled,
    set: setStoredSummariesDisabled,
    value: true,
    invalid: 'yes',
    normalizedInvalid: false,
    cases: [
      [false, false],
      [undefined, false],
      ['true', false],
      [1, false],
    ],
  },
  {
    name: 'LLM concurrency',
    key: MAX_PARALLEL_LLM_REQUESTS_KEY,
    fallback: DEFAULT_MAX_PARALLEL_LLM_REQUESTS,
    normalize: normalizeMaxParallelLlmRequests,
    get: getStoredMaxParallelLlmRequests,
    set: setStoredMaxParallelLlmRequests,
    value: 8,
    invalid: 'invalid',
    normalizedInvalid: DEFAULT_MAX_PARALLEL_LLM_REQUESTS,
    cases: [
      ['6', 6],
      [3.9, 3],
      [0, MIN_PARALLEL_LLM_REQUESTS],
      [999, MAX_PARALLEL_LLM_REQUESTS],
    ],
  },
  {
    name: 'LLM timeout',
    key: LLM_REQUEST_TIMEOUT_SECONDS_KEY,
    fallback: DEFAULT_LLM_REQUEST_TIMEOUT_SECONDS,
    normalize: normalizeLlmRequestTimeoutSeconds,
    get: getStoredLlmRequestTimeoutSeconds,
    set: setStoredLlmRequestTimeoutSeconds,
    value: 300,
    invalid: 'invalid',
    normalizedInvalid: DEFAULT_LLM_REQUEST_TIMEOUT_SECONDS,
    cases: [
      ['600', 600],
      [30.9, 30],
      [0, MIN_LLM_REQUEST_TIMEOUT_SECONDS],
      [Number.MAX_SAFE_INTEGER, MAX_LLM_REQUEST_TIMEOUT_SECONDS],
    ],
  },
];

function stubStorage({ get, set } = {}) {
  vi.stubGlobal('chrome', {
    runtime: {},
    storage: {
      local: {
        get: get || vi.fn((key, callback) => callback({ [key]: undefined })),
        set: set || vi.fn((_items, callback) => callback()),
      },
    },
  });
}

describe.each(settings)('$name stored setting', (setting) => {
  it('normalizes values and reads/writes the configured key', async () => {
    expect(setting.normalize(setting.value)).toBe(setting.value);
    expect(setting.normalize(setting.invalid)).toBe(setting.normalizedInvalid);
    for (const [input, expected] of setting.cases) expect(setting.normalize(input)).toBe(expected);

    stubStorage({ get: vi.fn((_key, callback) => callback({})) });
    await expect(setting.get()).resolves.toBe(setting.fallback);

    stubStorage({ get: vi.fn((key, callback) => callback({ [key]: setting.value })) });
    await expect(setting.get()).resolves.toBe(setting.value);
    chrome.storage.local.get.mockImplementation((key, callback) =>
      callback({ [key]: setting.invalid }),
    );
    await expect(setting.get()).resolves.toBe(setting.normalizedInvalid);
    await expect(setting.set(setting.value)).resolves.toBe(setting.value);
    expect(chrome.storage.local.set).toHaveBeenCalledWith(
      { [setting.key]: setting.value },
      expect.any(Function),
    );
    await expect(setting.set(setting.invalid)).resolves.toBe(setting.normalizedInvalid);
    expect(chrome.storage.local.set).toHaveBeenCalledWith(
      { [setting.key]: setting.normalizedInvalid },
      expect.any(Function),
    );
  });
});

describe('stored setting failure paths', () => {
  it('returns the configured fallback for lastError and synchronous read failures', async () => {
    stubStorage({ get: vi.fn((key, callback) => callback({ [key]: true })) });
    chrome.runtime.lastError = { message: 'read failed' };
    for (const setting of settings) await expect(setting.get()).resolves.toBe(setting.fallback);

    chrome.runtime.lastError = undefined;
    chrome.storage.local.get = vi.fn(() => {
      throw new Error('storage unavailable');
    });
    for (const setting of settings) await expect(setting.get()).resolves.toBe(setting.fallback);
  });

  it('rejects writes when storage reports an error or throws', async () => {
    stubStorage();
    chrome.runtime.lastError = { message: 'write failed' };
    for (const setting of settings)
      await expect(setting.set(setting.value)).rejects.toThrow('write failed');

    chrome.runtime.lastError = undefined;
    chrome.storage.local.set = vi.fn(() => {
      throw new Error('storage unavailable');
    });
    for (const setting of settings)
      await expect(setting.set(setting.value)).rejects.toThrow('storage unavailable');
  });
});
