// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../core/metrics/parser.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, getParserMetrics: vi.fn() };
});

vi.mock('../core/metrics/resplit.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, getResplitMetrics: vi.fn() };
});

vi.mock('../utils/runtimeMessages.js', () => ({ sendRuntimeMessage: vi.fn() }));

import { emptyParserMetrics, getParserMetrics } from '../core/metrics/parser.js';
import { emptyResplitMetrics, getResplitMetrics } from '../core/metrics/resplit.js';
import { sendRuntimeMessage } from '../utils/runtimeMessages.js';
import { ParserMetricsSection } from './ParserMetricsSection.jsx';
import { ResplitMetricsSection } from './ResplitMetricsSection.jsx';
import { createFakeStore } from '../../test/fakes/storeFake.mjs';

const cleanups = [];
let store;

function renderSection(Component) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<Component store={store} />));
  cleanups.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return container;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  store = createFakeStore();
  getParserMetrics.mockReset().mockResolvedValue(emptyParserMetrics());
  getResplitMetrics.mockReset().mockResolvedValue(emptyResplitMetrics());
  sendRuntimeMessage.mockReset().mockResolvedValue({ ok: true });
});

afterEach(() => {
  while (cleanups.length) cleanups.pop()();
  vi.unstubAllGlobals();
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

describe('metrics clear failure recovery', () => {
  it('clears parser metrics after the worker acknowledges the clear', async () => {
    getParserMetrics.mockResolvedValueOnce({ ...emptyParserMetrics(), totalCount: 1 });
    const container = renderSection(ParserMetricsSection);
    await flush();

    await act(async () => {
      container.querySelector('button').click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(sendRuntimeMessage).toHaveBeenCalledWith({ type: 'clearParserMetrics' });
    expect(container.textContent).toContain('No topic parser attempts recorded yet.');
  });

  it('clears resplit metrics after the worker acknowledges the clear', async () => {
    getResplitMetrics.mockResolvedValueOnce({ ...emptyResplitMetrics(), runCount: 1 });
    const container = renderSection(ResplitMetricsSection);
    await flush();

    await act(async () => {
      container.querySelector('button').click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(sendRuntimeMessage).toHaveBeenCalledWith({ type: 'clearResplitMetrics' });
    expect(container.textContent).toContain('No topic range resplit runs recorded yet.');
  });

  it('renders parser attempt, repair, retry, and quirk metrics', async () => {
    const metrics = emptyParserMetrics();
    metrics.totalCount = 1;
    metrics.successCount = 1;
    metrics.repairedCount = 1;
    metrics.retryRecoveredCount = 1;
    metrics.totals.invalidRangeTokens = 2;
    metrics.recent = [
      {
        at: Date.now(),
        scope: 'chat',
        attempt: 2,
        sentenceCount: 3,
        inputLineCount: 4,
        parsedRangeCount: 2,
        ok: true,
        recoveredAfterRetry: true,
        repaired: true,
        quirks: {
          invalidRangeTokens: 1,
          outOfRangeRanges: 0,
          duplicateSentences: 0,
          missingSentences: 0,
          reversedRanges: 0,
          ignoredLines: 0,
        },
      },
    ];
    getParserMetrics.mockResolvedValueOnce(metrics);
    const container = renderSection(ParserMetricsSection);
    await flush();

    expect(container.textContent).toContain('Attempts (ok / error)1 (1 / 0)');
    expect(container.textContent).toContain('Successful parses needing repair1');
    expect(container.textContent).toContain('Recovered after parser retry1');
    expect(container.textContent).toContain('Invalid range tokens2');
    expect(container.textContent).toContain('recovered');
    expect(container.textContent).toContain('1 invalid token(s)');
  });

  it('reloads parser metrics and re-enables clear after a rejected clear', async () => {
    getParserMetrics
      .mockResolvedValueOnce({ ...emptyParserMetrics(), totalCount: 2, failureCount: 2 })
      .mockResolvedValueOnce({ ...emptyParserMetrics(), totalCount: 3, failureCount: 3 });
    sendRuntimeMessage.mockResolvedValueOnce({ ok: false, error: 'storage unavailable' });
    const container = renderSection(ParserMetricsSection);
    await flush();

    await act(async () => {
      container.querySelector('button').click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(sendRuntimeMessage).toHaveBeenCalledWith({ type: 'clearParserMetrics' });
    expect(getParserMetrics).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('3 (0 / 3)');
    expect(container.querySelector('[role="alert"]').textContent).toContain('storage unavailable');
  });

  it('reloads resplit metrics and re-enables clear after a rejected clear', async () => {
    getResplitMetrics
      .mockResolvedValueOnce({ ...emptyResplitMetrics(), runCount: 2 })
      .mockResolvedValueOnce({ ...emptyResplitMetrics(), runCount: 3 });
    sendRuntimeMessage.mockResolvedValueOnce({ ok: false, error: 'storage unavailable' });
    const container = renderSection(ResplitMetricsSection);
    await flush();

    await act(async () => {
      container.querySelector('button').click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(sendRuntimeMessage).toHaveBeenCalledWith({ type: 'clearResplitMetrics' });
    expect(getResplitMetrics).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('Runs reaching the resplit check3');
    expect(container.querySelector('[role="alert"]').textContent).toContain('storage unavailable');
  });

  it('preserves parser metrics and reports both errors when the recovery reload also fails', async () => {
    getParserMetrics
      .mockResolvedValueOnce({ ...emptyParserMetrics(), totalCount: 2, failureCount: 2 })
      .mockRejectedValueOnce(new Error('reload unavailable'));
    sendRuntimeMessage.mockRejectedValueOnce(new Error('worker disconnected'));
    const container = renderSection(ParserMetricsSection);
    await flush();

    await act(async () => {
      container.querySelector('button').click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('2 (0 / 2)');
    expect(container.querySelector('[role="alert"]').textContent).toContain('worker disconnected');
    expect(container.querySelector('[role="alert"]').textContent).toContain('reload unavailable');
    expect(container.querySelector('button').disabled).toBe(false);
  });

  it('preserves resplit metrics and reports both errors when the recovery reload also fails', async () => {
    getResplitMetrics
      .mockResolvedValueOnce({ ...emptyResplitMetrics(), runCount: 2 })
      .mockRejectedValueOnce(new Error('reload unavailable'));
    sendRuntimeMessage.mockRejectedValueOnce(new Error('worker disconnected'));
    const container = renderSection(ResplitMetricsSection);
    await flush();

    await act(async () => {
      container.querySelector('button').click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Runs reaching the resplit check2');
    expect(container.querySelector('[role="alert"]').textContent).toContain('worker disconnected');
    expect(container.querySelector('[role="alert"]').textContent).toContain('reload unavailable');
    expect(container.querySelector('button').disabled).toBe(false);
  });
});
