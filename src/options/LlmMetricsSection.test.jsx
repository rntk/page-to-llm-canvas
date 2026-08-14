// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../worker/metrics/llm.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getLlmMetrics: vi.fn(),
    clearLlmMetrics: vi.fn(),
  };
});

import {
  LLM_METRICS_KEY,
  clearLlmMetrics,
  emptyLlmMetrics,
  getLlmMetrics,
} from '../../worker/metrics/llm.js';
import { LlmMetricsSection } from './LlmMetricsSection.jsx';
import { createFakeStore } from '../../test/fakes/storeFake.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function metricTotals(overrides = {}) {
  const { epoch: _epoch, recent: _recent, byTaskType: _byTaskType, ...totals } = emptyLlmMetrics();
  return { ...totals, ...overrides };
}

function populatedMetrics() {
  return {
    ...emptyLlmMetrics(),
    totalCount: 3,
    successCount: 2,
    failureCount: 1,
    totalDurationMs: 7350,
    minDurationMs: 350,
    maxDurationMs: 5000,
    usageSampleCount: 2,
    cacheSampleCount: 2,
    totalInputTokens: 1234,
    totalOutputTokens: 2345,
    totalTokens: 3579,
    totalReasoningTokens: 42,
    totalCacheReadTokens: 600,
    totalCacheWriteTokens: 100,
    totalCacheMissTokens: 300,
    totalRequestChars: 12_345,
    totalResponseChars: 6_789,
    byTaskType: {
      chat_answer: metricTotals({
        totalCount: 2,
        successCount: 1,
        failureCount: 1,
        totalDurationMs: 7000,
        minDurationMs: 2000,
        maxDurationMs: 5000,
        usageSampleCount: 2,
        cacheSampleCount: 1,
        totalInputTokens: 1200,
        totalOutputTokens: 2300,
        totalTokens: 3500,
        totalCacheReadTokens: 600,
        totalCacheWriteTokens: 100,
        totalCacheMissTokens: 300,
      }),
      article_summary: metricTotals({
        totalCount: 1,
        successCount: 1,
        totalDurationMs: 350,
        minDurationMs: 350,
        maxDurationMs: 350,
      }),
    },
    recent: [
      {
        at: Date.UTC(2026, 0, 2, 3, 4, 5),
        taskType: 'chat_answer',
        provider: 'OpenAI',
        model: 'gpt-test',
        durationMs: 5000,
        ok: false,
        error: 'rate limited',
        usage: { inputTokens: 1000, outputTokens: 2000, cacheReadTokens: 500 },
      },
      {
        at: 0,
        taskType: 'article_summary',
        model: 'model-only',
        durationMs: 350,
        ok: true,
      },
      {
        at: 1,
        taskType: 'custom_task',
        durationMs: 2000,
        ok: true,
        usage: { inputTokens: 12, outputTokens: 34, cacheReadTokens: 0 },
      },
    ],
  };
}

const cleanups = [];
let store;

function renderSection() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<LlmMetricsSection store={store} />));
  let mounted = true;
  const unmount = () => {
    if (!mounted) return;
    mounted = false;
    act(() => root.unmount());
    container.remove();
  };
  cleanups.push(unmount);
  return { container, unmount };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function row(container, label) {
  return [...container.querySelectorAll('tr')].find(
    (candidate) => candidate.querySelector('th')?.textContent === label,
  );
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  store = createFakeStore();
  getLlmMetrics.mockReset().mockResolvedValue(emptyLlmMetrics());
  clearLlmMetrics.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  while (cleanups.length) cleanups.pop()();
  vi.unstubAllGlobals();
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

describe('LlmMetricsSection', () => {
  it('starts empty, loads metrics, and renders every populated report section', async () => {
    getLlmMetrics.mockResolvedValue(populatedMetrics());
    const { container } = renderSection();

    expect(container.querySelector('h2').textContent).toBe('LLM Request Metrics');
    expect(container.querySelector('.empty').textContent).toBe('No LLM requests recorded yet.');
    expect(container.querySelector('button').disabled).toBe(true);

    await flush();

    expect(container.querySelector('.empty')).toBeNull();
    expect(row(container, 'Total requests').querySelector('td').textContent).toBe('3');
    expect(row(container, 'Succeeded / failed').querySelector('td').textContent).toContain('2 / 1');
    expect(row(container, 'Average').querySelector('td').textContent).toBe('2.45 s');
    expect(row(container, 'Min / max').querySelector('td').textContent).toContain(
      '350 ms / 5.00 s',
    );
    expect(row(container, 'Input / output tokens').querySelector('td').textContent).toContain(
      '1,234 / 2,345',
    );
    expect(row(container, 'Total tokens').querySelector('td').textContent).toBe('3,579');
    expect(row(container, 'Reasoning tokens').querySelector('td').textContent).toBe('42');
    expect(
      row(container, 'Cache read / write / uncached').querySelector('td').textContent,
    ).toContain('600 / 100 / 300');
    expect(row(container, 'Cache hit rate').querySelector('td').textContent).toBe('60.0%');
    expect(
      row(container, 'Prompt / response characters').querySelector('td').textContent,
    ).toContain('12,345 / 6,789');
    expect(row(container, 'Responses with token usage').querySelector('td').textContent).toContain(
      '2 / 2',
    );

    const titles = [...container.querySelectorAll('.collapsible-title')].map(
      (el) => el.textContent,
    );
    expect(titles).toEqual([
      'LLM Request Metrics',
      'By task type',
      'Token and cache usage by task type',
      'Recent requests (newest first)',
    ]);
    expect(container.textContent).toContain('Chat answer');
    expect(container.textContent).toContain('Article summary');
    expect(container.textContent).toContain('Custom Task');
    expect(container.textContent).toContain('OpenAI');
    expect(container.textContent).toContain('gpt-test');
    expect(container.textContent).toContain('Unknown');
    expect(container.textContent).toContain('model-only');
    expect(container.textContent).toContain('—');
    expect(container.textContent).toContain('error');
    expect(container.querySelector('td[title="rate limited"]').textContent).toBe('error');
    expect(container.querySelector('button').disabled).toBe(false);

    const byTaskSection = [...container.querySelectorAll('details')].find(
      (section) => section.querySelector('summary')?.textContent === 'By task type',
    );
    const byTaskRows = [...byTaskSection.querySelectorAll('tbody tr')];
    expect(byTaskRows).toHaveLength(2);
    expect([...byTaskRows[0].children].map((cell) => cell.textContent)).toEqual([
      'Chat answer',
      '2',
      '1 / 1',
      '3.50 s',
      '2.00 s / 5.00 s',
    ]);
    expect([...byTaskRows[1].children].map((cell) => cell.textContent)).toEqual([
      'Article summary',
      '1',
      '1 / 0',
      '350 ms',
      '350 ms / 350 ms',
    ]);

    const usageSection = [...container.querySelectorAll('details')].find(
      (section) =>
        section.querySelector('summary')?.textContent === 'Token and cache usage by task type',
    );
    const usageRows = [...usageSection.querySelectorAll('tbody tr')];
    expect(usageRows).toHaveLength(2);
    expect([...usageRows[0].children].map((cell) => cell.textContent)).toEqual([
      'Chat answer',
      '2',
      '1,200',
      '2,300',
      '3,500',
      '600',
      '100',
      '300',
      '60.0%',
    ]);
    expect([...usageRows[1].children].map((cell) => cell.textContent)).toEqual([
      'Article summary',
      '0',
      '—',
      '—',
      '—',
      '—',
      '—',
      '—',
      '—',
    ]);

    const recentSection = [...container.querySelectorAll('details')].find(
      (section) =>
        section.querySelector('summary')?.textContent === 'Recent requests (newest first)',
    );
    const recentRows = [...recentSection.querySelectorAll('tbody tr')];
    expect(recentRows).toHaveLength(3);
    expect(recentRows[0].children[0].textContent).toBe(
      new Date(Date.UTC(2026, 0, 2, 3, 4, 5)).toLocaleString(),
    );
    expect(recentRows[0].children[2].textContent).toBe('OpenAIgpt-test');
    expect(recentRows[0].children[4].textContent).toContain('1,000 / 2,000');
    expect(recentRows[0].children[5].textContent).toBe('500');
    expect(recentRows[0].children[6].textContent).toBe('error');
    expect(recentRows[1].children[0].textContent).toBe('');
    expect(recentRows[1].children[2].textContent).toBe('Unknownmodel-only');
    expect(recentRows[1].children[4].textContent).toContain('— / —');
    expect(recentRows[1].children[5].textContent).toBe('—');
    expect(recentRows[1].children[6].textContent).toBe('ok');
    expect(recentRows[2].children[2].textContent).toBe('—');
  });

  it('shows unavailable token and cache values when no provider reports usage', async () => {
    getLlmMetrics.mockResolvedValue({
      ...emptyLlmMetrics(),
      totalCount: 1,
      successCount: 1,
      totalDurationMs: 100,
      minDurationMs: 100,
      maxDurationMs: 100,
      totalRequestChars: 10,
      totalResponseChars: 20,
      byTaskType: {
        topic_ranges: metricTotals({
          totalCount: 1,
          successCount: 1,
          totalDurationMs: 100,
          minDurationMs: 100,
          maxDurationMs: 100,
        }),
      },
    });
    const { container } = renderSection();
    await flush();

    expect(row(container, 'Input / output tokens').querySelector('td').textContent).toContain(
      '— / —',
    );
    expect(row(container, 'Total tokens').querySelector('td').textContent).toBe('—');
    expect(
      row(container, 'Cache read / write / uncached').querySelector('td').textContent,
    ).toContain('— / — / —');
    expect(row(container, 'Reasoning tokens')).toBeUndefined();
    expect(container.textContent).toContain('By task type');
    expect(container.textContent).not.toContain('Token and cache usage by task type');
    expect(container.textContent).not.toContain('Recent requests (newest first)');
  });

  it('watches the metrics key and normalizes each published value', async () => {
    const { container } = renderSection();
    await flush();

    expect(store.subscribedKeys).toEqual([LLM_METRICS_KEY]);

    // An unset/cleared key normalizes back to the empty report rather than
    // rendering a partial one.
    act(() => store.publish(undefined));
    expect(container.querySelector('.empty')).not.toBeNull();

    act(() => store.publish({ totalCount: '2', successCount: 2 }));
    expect(row(container, 'Total requests').querySelector('td').textContent).toBe('2');
    expect(row(container, 'Succeeded / failed').querySelector('td').textContent).toContain('2 / 0');
  });

  it('disables clear while pending and resets the report after success', async () => {
    getLlmMetrics.mockResolvedValue(populatedMetrics());
    const pendingClear = deferred();
    clearLlmMetrics.mockReturnValue(pendingClear.promise);
    const { container } = renderSection();
    await flush();
    const button = container.querySelector('button');

    act(() => button.click());
    expect(clearLlmMetrics).toHaveBeenCalledTimes(1);
    expect(button.textContent).toBe('Clearing...');
    expect(button.disabled).toBe(true);

    pendingClear.resolve();
    await flush();
    expect(button.textContent).toBe('Clear metrics');
    expect(button.disabled).toBe(true);
    expect(container.querySelector('.empty').textContent).toBe('No LLM requests recorded yet.');
  });

  it('reloads stored metrics and re-enables clear when clearing fails', async () => {
    getLlmMetrics
      .mockResolvedValueOnce(populatedMetrics())
      .mockResolvedValueOnce({ ...emptyLlmMetrics(), totalCount: 4, failureCount: 4 });
    clearLlmMetrics.mockRejectedValue(new Error('storage unavailable'));
    const { container } = renderSection();
    await flush();

    await act(async () => {
      container.querySelector('button').click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getLlmMetrics).toHaveBeenCalledTimes(2);
    expect(row(container, 'Total requests').querySelector('td').textContent).toBe('4');
    expect(container.textContent).not.toContain('By task type');
    expect(container.querySelector('button').textContent).toBe('Clear metrics');
    expect(container.querySelector('button').disabled).toBe(false);
  });

  // Tolerating a missing or throwing chrome.storage.onChanged is the adapter's
  // job, covered in src/shared/runtime/localStore.test.js. What this section
  // owes is releasing its subscription and not setting state after unmount.
  it('unsubscribes and ignores an initial load that finishes after unmount', async () => {
    const load = deferred();
    getLlmMetrics.mockReturnValue(load.promise);
    const { unmount } = renderSection();

    unmount();
    expect(store.unsubscribe).toHaveBeenCalledOnce();
    expect(store.listenerCount).toBe(0);

    load.resolve(populatedMetrics());
    await flush();
  });
});
