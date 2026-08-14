// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sendRuntimeMessage = vi.hoisted(() => vi.fn());
vi.mock('../utils/runtimeMessages.js', () => ({ sendRuntimeMessage }));

vi.mock('../../worker/metrics/chatTool.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, getChatToolMetrics: vi.fn() };
});

import {
  CHAT_TOOL_OUTCOMES,
  emptyChatToolMetrics,
  getChatToolMetrics,
} from '../../worker/metrics/chatTool.js';
import { ChatToolMetricsSection } from './ChatToolMetricsSection.jsx';
import { createFakeStore } from '../../test/fakes/storeFake.mjs';

let root;
let container;
let store;

function metricsWithCalls(totalCount) {
  const metrics = emptyChatToolMetrics();
  metrics.totalCount = totalCount;
  metrics.okCount = totalCount;
  metrics.byOutcome[CHAT_TOOL_OUTCOMES.HIGHLIGHTED] = totalCount;
  return metrics;
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
  getChatToolMetrics.mockReset();
  sendRuntimeMessage.mockReset();

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

describe('ChatToolMetricsSection', () => {
  it('reloads persisted metrics when the worker resolves a failed clear response', async () => {
    getChatToolMetrics
      .mockResolvedValueOnce(metricsWithCalls(2))
      .mockResolvedValueOnce(metricsWithCalls(3));
    sendRuntimeMessage.mockResolvedValue({ ok: false, error: 'storage unavailable' });

    act(() => root.render(<ChatToolMetricsSection store={store} />));
    await flush();

    await act(async () => {
      container.querySelector('button').click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(sendRuntimeMessage).toHaveBeenCalledWith({ type: 'clearChatToolMetrics' });
    expect(getChatToolMetrics).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('3 (3 / 0)');
    expect(container.querySelector('.empty')).toBeNull();
    expect(container.querySelector('button').textContent).toBe('Clear chat tool metrics');
    expect(container.querySelector('button').disabled).toBe(false);
  });
});
