// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../core/settings/language.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getStoredPreferContentLanguage: vi.fn(),
    setStoredPreferContentLanguage: vi.fn(),
  };
});

vi.mock('../core/settings/summary.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getStoredSummariesDisabled: vi.fn(),
    setStoredSummariesDisabled: vi.fn(),
  };
});

vi.mock('../shared/runtime/verboseLogSettings.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getStoredVerboseLogs: vi.fn(),
    setStoredVerboseLogs: vi.fn(),
  };
});

vi.mock('../core/settings/llmConcurrency.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getStoredMaxParallelLlmRequests: vi.fn(),
    setStoredMaxParallelLlmRequests: vi.fn(),
  };
});

vi.mock('../core/settings/llmTimeout.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getStoredLlmRequestTimeoutSeconds: vi.fn(),
    setStoredLlmRequestTimeoutSeconds: vi.fn(),
  };
});

vi.mock('../highlights/highlightSettings.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, getStoredHighlightColor: vi.fn(), setStoredHighlightColor: vi.fn() };
});

import {
  DEFAULT_PREFER_CONTENT_LANGUAGE,
  getStoredPreferContentLanguage,
  setStoredPreferContentLanguage,
} from '../core/settings/language.js';
import {
  DEFAULT_SUMMARIES_DISABLED,
  getStoredSummariesDisabled,
  setStoredSummariesDisabled,
} from '../core/settings/summary.js';
import {
  DEFAULT_VERBOSE_LOGS,
  getStoredVerboseLogs,
  setStoredVerboseLogs,
} from '../shared/runtime/verboseLogSettings.js';
import {
  DEFAULT_MAX_PARALLEL_LLM_REQUESTS,
  MIN_PARALLEL_LLM_REQUESTS,
  MAX_PARALLEL_LLM_REQUESTS,
  getStoredMaxParallelLlmRequests,
  setStoredMaxParallelLlmRequests,
} from '../core/settings/llmConcurrency.js';
import {
  DEFAULT_LLM_REQUEST_TIMEOUT_SECONDS,
  MIN_LLM_REQUEST_TIMEOUT_SECONDS,
  MAX_LLM_REQUEST_TIMEOUT_SECONDS,
  getStoredLlmRequestTimeoutSeconds,
  setStoredLlmRequestTimeoutSeconds,
} from '../core/settings/llmTimeout.js';
import {
  DEFAULT_HIGHLIGHT_COLOR,
  getStoredHighlightColor,
  setStoredHighlightColor,
} from '../highlights/highlightSettings.js';
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

async function typeNumber(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  await act(async () => {
    input.focus();
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function blurInput(input) {
  await act(async () => {
    input.dispatchEvent(new Event('focusout', { bubbles: true }));
  });
  await flush();
}

async function pressKey(input, key) {
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
  await flush();
}

async function changeColorValue(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  store = createFakeStore();
  scheduler = { setTimeout: vi.fn(), clearTimeout: vi.fn() };
  scheduler.setTimeout.mockImplementation((fn) => ({ fn }));

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
  getStoredHighlightColor.mockReset().mockResolvedValue(DEFAULT_HIGHLIGHT_COLOR);
  setStoredHighlightColor.mockReset().mockResolvedValue(undefined);

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

const checkboxSections = [
  {
    name: 'content language',
    Component: ContentLanguageSection,
    id: 'prefer-content-language',
    get: getStoredPreferContentLanguage,
    set: setStoredPreferContentLanguage,
    text: 'Prefer the language of the content',
    note: 'dominant language of the analyzed content',
  },
  {
    name: 'summary generation',
    Component: SummaryGenerationSection,
    id: 'disable-summaries',
    get: getStoredSummariesDisabled,
    set: setStoredSummariesDisabled,
    text: 'Disable summary generation',
    note: 'processing stops after topic detection',
  },
  {
    name: 'verbose logs',
    Component: VerboseLogsSection,
    id: 'verbose-logs',
    get: getStoredVerboseLogs,
    set: setStoredVerboseLogs,
    text: 'Verbose pipeline and chat logs',
    note: 'each pipeline stage and chat turn',
  },
];

describe.each(checkboxSections)('$name section', ({ Component, id, get, set, text, note }) => {
  it('renders its description and loads the stored checkbox value', async () => {
    get.mockResolvedValue(true);
    act(() => root.render(<Component store={store} />));
    await flush();
    const input = container.querySelector(`#${id}`);
    expect(container.textContent).toContain(text);
    expect(container.querySelector('.note').textContent).toContain(note);
    expect(input.type).toBe('checkbox');
    expect(input.checked).toBe(true);
    expect(container.querySelector('label').htmlFor).toBe(input.id);
  });

  it('saves the toggled value', async () => {
    get.mockResolvedValue(false);
    act(() => root.render(<Component store={store} />));
    await flush();
    await clickCheckbox(container.querySelector(`#${id}`));
    expect(set).toHaveBeenCalledWith(true);
  });
});

const numericSections = [
  {
    name: 'LLM concurrency',
    Component: LlmConcurrencySection,
    id: 'max-parallel-llm-requests',
    get: getStoredMaxParallelLlmRequests,
    set: setStoredMaxParallelLlmRequests,
    value: 9,
    changed: '10',
    initial: 4,
    min: MIN_PARALLEL_LLM_REQUESTS,
    max: MAX_PARALLEL_LLM_REQUESTS,
    text: 'Maximum parallel requests',
    note: 'Limits LLM calls across all pages',
  },
  {
    name: 'LLM request timeout',
    Component: LlmRequestTimeoutSection,
    id: 'llm-request-timeout-seconds',
    get: getStoredLlmRequestTimeoutSeconds,
    set: setStoredLlmRequestTimeoutSeconds,
    value: 45,
    changed: '60',
    initial: 120,
    min: MIN_LLM_REQUEST_TIMEOUT_SECONDS,
    max: MAX_LLM_REQUEST_TIMEOUT_SECONDS,
    text: 'Timeout (seconds)',
    note: 'Maximum time allowed for each LLM request',
  },
];

describe.each(numericSections)(
  '$name section',
  ({ Component, id, get, set, value, changed, initial, min, max, text, note }) => {
    it('renders its description and configured input with the stored value', async () => {
      get.mockResolvedValue(value);
      act(() => root.render(<Component store={store} />));
      await flush();
      const input = container.querySelector(`#${id}`);
      expect(container.textContent).toContain(text);
      expect(container.querySelector('.note').textContent).toContain(note);
      expect(input.type).toBe('number');
      expect(input.value).toBe(String(value));
      expect(input.min).toBe(String(min));
      expect(input.max).toBe(String(max));
      expect(input.step).toBe('1');
    });

    it('saves the changed numeric value', async () => {
      get.mockResolvedValue(initial);
      act(() => root.render(<Component store={store} />));
      await flush();
      const input = container.querySelector(`#${id}`);
      await changeNumberValue(input, changed);
      await blurInput(input);
      expect(set).toHaveBeenCalledWith(Number(changed));
    });

    it('does not persist intermediate keystrokes and commits once on blur', async () => {
      get.mockResolvedValue(initial);
      act(() => root.render(<Component store={store} scheduler={scheduler} />));
      await flush();
      const input = container.querySelector(`#${id}`);
      for (const partial of ['1', '12', '120']) await typeNumber(input, partial);
      expect(set).not.toHaveBeenCalled();
      expect(input.value).toBe('120');

      await blurInput(input);
      expect(set).toHaveBeenCalledTimes(1);
      expect(set).toHaveBeenCalledWith(Math.min(Math.max(120, min), max));
    });

    it('lets the field be cleared without persisting the default until commit', async () => {
      get.mockResolvedValue(initial);
      act(() => root.render(<Component store={store} scheduler={scheduler} />));
      await flush();
      const input = container.querySelector(`#${id}`);
      await typeNumber(input, '');
      expect(input.value).toBe('');
      expect(set).not.toHaveBeenCalled();
      // A debounce firing on an empty draft must not commit it either.
      const timers = scheduler.setTimeout.mock.calls;
      if (timers.length) await act(async () => timers[timers.length - 1][0]());
      expect(set).not.toHaveBeenCalled();
      expect(input.value).toBe('');

      await blurInput(input);
      expect(set).toHaveBeenCalledTimes(1);
      expect(input.value).not.toBe('');
    });

    it('commits on Enter', async () => {
      get.mockResolvedValue(initial);
      act(() => root.render(<Component store={store} scheduler={scheduler} />));
      await flush();
      const input = container.querySelector(`#${id}`);
      await typeNumber(input, changed);
      expect(set).not.toHaveBeenCalled();
      await pressKey(input, 'Enter');
      expect(set).toHaveBeenCalledWith(Number(changed));
    });

    it('commits the latest draft when the debounce fires', async () => {
      get.mockResolvedValue(initial);
      act(() => root.render(<Component store={store} scheduler={scheduler} />));
      await flush();
      const input = container.querySelector(`#${id}`);
      await typeNumber(input, '1');
      await typeNumber(input, changed);
      expect(scheduler.clearTimeout).toHaveBeenCalled();
      expect(set).not.toHaveBeenCalled();
      const lastTimer = scheduler.setTimeout.mock.calls.at(-1);
      await act(async () => lastTimer[0]());
      await flush();
      expect(set).toHaveBeenCalledTimes(1);
      expect(set).toHaveBeenCalledWith(Number(changed));
    });

    it('reflects external changes when unfocused but keeps an in-progress draft', async () => {
      get.mockResolvedValue(initial);
      act(() => root.render(<Component store={store} scheduler={scheduler} />));
      await flush();
      const input = container.querySelector(`#${id}`);
      await act(async () => store.publish(value));
      expect(input.value).toBe(String(value));

      await typeNumber(input, changed);
      await act(async () => store.publish(initial));
      expect(input.value).toBe(changed);
      expect(set).not.toHaveBeenCalled();
    });
  },
);

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

  it('debounces highlight persistence and persists the latest preview', async () => {
    act(() => root.render(<GeneralSettingsPanel store={store} scheduler={scheduler} />));
    await flush();
    const input = container.querySelector('#highlight-color');
    await changeColorValue(input, '#112233');
    await changeColorValue(input, '#445566');

    expect(scheduler.setTimeout).toHaveBeenCalledTimes(2);
    expect(scheduler.clearTimeout).toHaveBeenCalledTimes(1);
    expect(setStoredHighlightColor).not.toHaveBeenCalled();
    await act(async () => scheduler.setTimeout.mock.calls[1][0]());
    expect(setStoredHighlightColor).toHaveBeenCalledTimes(1);
    expect(setStoredHighlightColor).toHaveBeenCalledWith('#445566');
  });

  it('flushes the pending highlight write on unmount', async () => {
    act(() => root.render(<GeneralSettingsPanel store={store} scheduler={scheduler} />));
    await flush();
    const input = container.querySelector('#highlight-color');
    await changeColorValue(input, '#123456');

    act(() => root.unmount());
    expect(scheduler.clearTimeout).toHaveBeenCalled();
    expect(setStoredHighlightColor).toHaveBeenCalledWith('#123456');
    root = createRoot(container);
  });

  it('rolls the preview back to stored color after a failed write', async () => {
    setStoredHighlightColor.mockRejectedValueOnce(new Error('write failed'));
    getStoredHighlightColor.mockResolvedValue(DEFAULT_HIGHLIGHT_COLOR);
    act(() => root.render(<GeneralSettingsPanel store={store} scheduler={scheduler} />));
    await flush();
    const input = container.querySelector('#highlight-color');
    await changeColorValue(input, '#123456');
    await act(async () => scheduler.setTimeout.mock.calls[0][0]());
    await flush();

    expect(getStoredHighlightColor).toHaveBeenCalledTimes(2);
    expect(input.value).toBe(DEFAULT_HIGHLIGHT_COLOR);
  });
});
