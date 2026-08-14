// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../worker/metrics/parser.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, getParserMetrics: vi.fn() };
});

vi.mock('../../worker/metrics/resplit.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, getResplitMetrics: vi.fn() };
});

vi.mock('../utils/runtimeMessages.js', () => ({ sendRuntimeMessage: vi.fn() }));

import { emptyParserMetrics, getParserMetrics } from '../../worker/metrics/parser.js';
import { emptyResplitMetrics, getResplitMetrics } from '../../worker/metrics/resplit.js';
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
    expect(container.querySelector('button').textContent).toBe('Clear parser metrics');
    expect(container.querySelector('button').disabled).toBe(false);
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
    expect(container.querySelector('button').textContent).toBe('Clear resplit metrics');
    expect(container.querySelector('button').disabled).toBe(false);
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
