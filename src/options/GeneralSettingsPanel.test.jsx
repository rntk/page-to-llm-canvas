// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../worker/settings/language.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getStoredPreferContentLanguage: vi.fn(),
    setStoredPreferContentLanguage: vi.fn(),
  };
});

vi.mock('../../worker/settings/summary.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getStoredSummariesDisabled: vi.fn(),
    setStoredSummariesDisabled: vi.fn(),
  };
});

vi.mock('../../worker/settings/verboseLog.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getStoredVerboseLogs: vi.fn(),
    setStoredVerboseLogs: vi.fn(),
  };
});

vi.mock('../../worker/settings/llmConcurrency.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getStoredMaxParallelLlmRequests: vi.fn(),
    setStoredMaxParallelLlmRequests: vi.fn(),
  };
});

vi.mock('../../worker/settings/llmTimeout.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getStoredLlmRequestTimeoutSeconds: vi.fn(),
    setStoredLlmRequestTimeoutSeconds: vi.fn(),
  };
});

import {
  DEFAULT_PREFER_CONTENT_LANGUAGE,
  getStoredPreferContentLanguage,
  setStoredPreferContentLanguage,
} from '../../worker/settings/language.js';
import {
  DEFAULT_SUMMARIES_DISABLED,
  getStoredSummariesDisabled,
  setStoredSummariesDisabled,
} from '../../worker/settings/summary.js';
import {
  DEFAULT_VERBOSE_LOGS,
  getStoredVerboseLogs,
  setStoredVerboseLogs,
} from '../../worker/settings/verboseLog.js';
import {
  DEFAULT_MAX_PARALLEL_LLM_REQUESTS,
  MIN_PARALLEL_LLM_REQUESTS,
  MAX_PARALLEL_LLM_REQUESTS,
  getStoredMaxParallelLlmRequests,
  setStoredMaxParallelLlmRequests,
} from '../../worker/settings/llmConcurrency.js';
import {
  DEFAULT_LLM_REQUEST_TIMEOUT_SECONDS,
  MIN_LLM_REQUEST_TIMEOUT_SECONDS,
  MAX_LLM_REQUEST_TIMEOUT_SECONDS,
  getStoredLlmRequestTimeoutSeconds,
  setStoredLlmRequestTimeoutSeconds,
} from '../../worker/settings/llmTimeout.js';
import {
  ContentLanguageSection,
  GeneralSettingsPanel,
  LlmConcurrencySection,
  LlmRequestTimeoutSection,
  SummaryGenerationSection,
  VerboseLogsSection,
} from './GeneralSettingsPanel.jsx';
import { createFakeStore } from '../../test/fakes/storeFake.mjs';

let root;
let container;
let store;
let scheduler;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function clickCheckbox(input) {
  await act(async () => {
    input.click();
  });
  await flush();
}

async function changeNumberValue(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await flush();
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  store = createFakeStore();
  scheduler = { setTimeout: vi.fn(), clearTimeout: vi.fn() };

  getStoredPreferContentLanguage.mockReset().mockResolvedValue(DEFAULT_PREFER_CONTENT_LANGUAGE);
  setStoredPreferContentLanguage.mockReset().mockResolvedValue(DEFAULT_PREFER_CONTENT_LANGUAGE);
  getStoredSummariesDisabled.mockReset().mockResolvedValue(DEFAULT_SUMMARIES_DISABLED);
  setStoredSummariesDisabled.mockReset().mockResolvedValue(DEFAULT_SUMMARIES_DISABLED);
  getStoredVerboseLogs.mockReset().mockResolvedValue(DEFAULT_VERBOSE_LOGS);
  setStoredVerboseLogs.mockReset().mockResolvedValue(DEFAULT_VERBOSE_LOGS);
  getStoredMaxParallelLlmRequests.mockReset().mockResolvedValue(DEFAULT_MAX_PARALLEL_LLM_REQUESTS);
  setStoredMaxParallelLlmRequests.mockReset().mockResolvedValue(DEFAULT_MAX_PARALLEL_LLM_REQUESTS);
  getStoredLlmRequestTimeoutSeconds
    .mockReset()
    .mockResolvedValue(DEFAULT_LLM_REQUEST_TIMEOUT_SECONDS);
  setStoredLlmRequestTimeoutSeconds
    .mockReset()
    .mockResolvedValue(DEFAULT_LLM_REQUEST_TIMEOUT_SECONDS);

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

describe('ContentLanguageSection', () => {
  it('renders its heading, label, and note', async () => {
    act(() => root.render(<ContentLanguageSection store={store} />));
    await flush();

    expect(container.querySelector('h3').textContent).toBe('Language');
    expect(container.textContent).toContain('Prefer the language of the content');
    expect(container.querySelector('.note').textContent).toContain(
      'dominant language of the analyzed content',
    );
  });

  it('loads and displays the stored value on mount', async () => {
    getStoredPreferContentLanguage.mockResolvedValue(true);
    act(() => root.render(<ContentLanguageSection store={store} />));
    await flush();

    const input = container.querySelector('#prefer-content-language');
    expect(input.checked).toBe(true);
  });

  it('is a checkbox whose label is associated with the input via htmlFor/id', async () => {
    act(() => root.render(<ContentLanguageSection store={store} />));
    await flush();

    const input = container.querySelector('#prefer-content-language');
    const label = container.querySelector('label');
    expect(input.type).toBe('checkbox');
    expect(label.htmlFor).toBe(input.id);
  });

  it('calls setStoredPreferContentLanguage with the normalized value on change', async () => {
    getStoredPreferContentLanguage.mockResolvedValue(false);
    act(() => root.render(<ContentLanguageSection store={store} />));
    await flush();

    const input = container.querySelector('#prefer-content-language');
    expect(input.checked).toBe(false);

    await clickCheckbox(input);

    expect(setStoredPreferContentLanguage).toHaveBeenCalledWith(true);
  });
});

describe('SummaryGenerationSection', () => {
  it('renders its heading, label, and note', async () => {
    act(() => root.render(<SummaryGenerationSection store={store} />));
    await flush();

    expect(container.querySelector('h3').textContent).toBe('Summaries');
    expect(container.textContent).toContain('Disable summary generation');
    expect(container.querySelector('.note').textContent).toContain(
      'processing stops after topic detection',
    );
  });

  it('loads and displays the stored value on mount', async () => {
    getStoredSummariesDisabled.mockResolvedValue(true);
    act(() => root.render(<SummaryGenerationSection store={store} />));
    await flush();

    const input = container.querySelector('#disable-summaries');
    expect(input.checked).toBe(true);
  });

  it('is a checkbox whose label is associated with the input via htmlFor/id', async () => {
    act(() => root.render(<SummaryGenerationSection store={store} />));
    await flush();

    const input = container.querySelector('#disable-summaries');
    const label = container.querySelector('label');
    expect(input.type).toBe('checkbox');
    expect(label.htmlFor).toBe(input.id);
  });

  it('calls setStoredSummariesDisabled with the normalized value on change', async () => {
    getStoredSummariesDisabled.mockResolvedValue(false);
    act(() => root.render(<SummaryGenerationSection store={store} />));
    await flush();

    const input = container.querySelector('#disable-summaries');
    expect(input.checked).toBe(false);

    await clickCheckbox(input);

    expect(setStoredSummariesDisabled).toHaveBeenCalledWith(true);
  });
});

describe('VerboseLogsSection', () => {
  it('renders its heading, label, and note', async () => {
    act(() => root.render(<VerboseLogsSection store={store} />));
    await flush();

    expect(container.querySelector('h3').textContent).toBe('Diagnostics');
    expect(container.textContent).toContain('Verbose pipeline and chat logs');
    expect(container.querySelector('.note').textContent).toContain(
      'each pipeline stage and chat turn',
    );
  });

  it('loads and displays the stored value on mount', async () => {
    getStoredVerboseLogs.mockResolvedValue(true);
    act(() => root.render(<VerboseLogsSection store={store} />));
    await flush();

    const input = container.querySelector('#verbose-logs');
    expect(input.checked).toBe(true);
  });

  it('is a checkbox whose label is associated with the input via htmlFor/id', async () => {
    act(() => root.render(<VerboseLogsSection store={store} />));
    await flush();

    const input = container.querySelector('#verbose-logs');
    const label = container.querySelector('label');
    expect(input.type).toBe('checkbox');
    expect(label.htmlFor).toBe(input.id);
  });

  it('calls setStoredVerboseLogs with the normalized value on change', async () => {
    getStoredVerboseLogs.mockResolvedValue(false);
    act(() => root.render(<VerboseLogsSection store={store} />));
    await flush();

    const input = container.querySelector('#verbose-logs');
    expect(input.checked).toBe(false);

    await clickCheckbox(input);

    expect(setStoredVerboseLogs).toHaveBeenCalledWith(true);
  });
});

describe('LlmConcurrencySection', () => {
  it('renders its heading, label, and note', async () => {
    act(() => root.render(<LlmConcurrencySection store={store} />));
    await flush();

    expect(container.querySelector('h3').textContent).toBe('LLM concurrency');
    expect(container.textContent).toContain('Maximum parallel requests');
    expect(container.querySelector('.note').textContent).toContain(
      'Limits LLM calls across all pages',
    );
  });

  it('loads and displays the stored value on mount', async () => {
    getStoredMaxParallelLlmRequests.mockResolvedValue(9);
    act(() => root.render(<LlmConcurrencySection store={store} />));
    await flush();

    const input = container.querySelector('#max-parallel-llm-requests');
    expect(input.value).toBe('9');
  });

  it('renders a number input with the configured type/min/max/step', async () => {
    act(() => root.render(<LlmConcurrencySection store={store} />));
    await flush();

    const input = container.querySelector('#max-parallel-llm-requests');
    expect(input.getAttribute('type')).toBe('number');
    expect(input.getAttribute('min')).toBe(String(MIN_PARALLEL_LLM_REQUESTS));
    expect(input.getAttribute('max')).toBe(String(MAX_PARALLEL_LLM_REQUESTS));
    expect(input.getAttribute('step')).toBe('1');
  });

  it('calls setStoredMaxParallelLlmRequests with the normalized value on change', async () => {
    getStoredMaxParallelLlmRequests.mockResolvedValue(4);
    act(() => root.render(<LlmConcurrencySection store={store} />));
    await flush();

    const input = container.querySelector('#max-parallel-llm-requests');
    await changeNumberValue(input, '9');

    expect(setStoredMaxParallelLlmRequests).toHaveBeenCalledWith(9);
  });
});

describe('LlmRequestTimeoutSection', () => {
  it('renders its heading, label, and note', async () => {
    act(() => root.render(<LlmRequestTimeoutSection store={store} />));
    await flush();

    expect(container.querySelector('h3').textContent).toBe('LLM request timeout');
    expect(container.textContent).toContain('Timeout (seconds)');
    expect(container.querySelector('.note').textContent).toContain(
      'Maximum time allowed for each LLM request',
    );
  });

  it('loads and displays the stored value on mount', async () => {
    getStoredLlmRequestTimeoutSeconds.mockResolvedValue(45);
    act(() => root.render(<LlmRequestTimeoutSection store={store} />));
    await flush();

    const input = container.querySelector('#llm-request-timeout-seconds');
    expect(input.value).toBe('45');
  });

  it('renders a number input with the configured type/min/max/step', async () => {
    act(() => root.render(<LlmRequestTimeoutSection store={store} />));
    await flush();

    const input = container.querySelector('#llm-request-timeout-seconds');
    expect(input.getAttribute('type')).toBe('number');
    expect(input.getAttribute('min')).toBe(String(MIN_LLM_REQUEST_TIMEOUT_SECONDS));
    expect(input.getAttribute('max')).toBe(String(MAX_LLM_REQUEST_TIMEOUT_SECONDS));
    expect(input.getAttribute('step')).toBe('1');
  });

  it('calls setStoredLlmRequestTimeoutSeconds with the normalized value on change', async () => {
    getStoredLlmRequestTimeoutSeconds.mockResolvedValue(120);
    act(() => root.render(<LlmRequestTimeoutSection store={store} />));
    await flush();

    const input = container.querySelector('#llm-request-timeout-seconds');
    await changeNumberValue(input, '45');

    expect(setStoredLlmRequestTimeoutSeconds).toHaveBeenCalledWith(45);
  });
});

describe('GeneralSettingsPanel', () => {
  it('renders all five preference section headings', async () => {
    act(() => root.render(<GeneralSettingsPanel store={store} scheduler={scheduler} />));
    await flush();

    const headings = Array.from(container.querySelectorAll('h3')).map((el) => el.textContent);
    expect(headings).toContain('Language');
    expect(headings).toContain('Summaries');
    expect(headings).toContain('LLM concurrency');
    expect(headings).toContain('LLM request timeout');
    expect(headings).toContain('Diagnostics');
  });
});
