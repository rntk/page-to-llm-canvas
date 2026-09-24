// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const sendRuntimeMessage = vi.hoisted(() => vi.fn());
vi.mock('../utils/runtimeMessages.js', () => ({ sendRuntimeMessage }));

import { useMetricsClear } from './useMetricsClear.js';

let root;
let container;

function renderHook(options) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const current = { value: null };
  function Harness() {
    current.value = useMetricsClear(options);
    return null;
  }
  act(() => root.render(createElement(Harness)));
  return current;
}

afterEach(() => {
  if (root) act(() => root.unmount());
  container?.remove();
  root = null;
  container = null;
  sendRuntimeMessage.mockReset();
  vi.restoreAllMocks();
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

describe('useMetricsClear', () => {
  it('clears metrics after the worker acknowledges the request', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const setMetrics = vi.fn();
    const empty = () => ({ count: 0 });
    sendRuntimeMessage.mockResolvedValue({ ok: true });
    const hook = renderHook({
      messageType: 'clearMetrics',
      defaultErrorMessage: 'Clear failed',
      empty,
      read: vi.fn(),
      setMetrics,
    });

    await act(async () => hook.value.handleClear());

    expect(sendRuntimeMessage).toHaveBeenCalledWith({ type: 'clearMetrics' });
    expect(setMetrics).toHaveBeenCalledWith({ count: 0 });
    expect(hook.value.isClearing).toBe(false);
    expect(hook.value.clearError).toBe('');
  });

  it('reloads stored metrics and reports the clear error after failure', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const setMetrics = vi.fn();
    const read = vi.fn().mockResolvedValue({ count: 4 });
    sendRuntimeMessage.mockResolvedValue({ ok: false, error: 'storage unavailable' });
    const hook = renderHook({
      messageType: 'clearMetrics',
      defaultErrorMessage: 'Clear failed',
      empty: () => ({ count: 0 }),
      read,
      setMetrics,
    });

    await act(async () => hook.value.handleClear());

    expect(read).toHaveBeenCalledOnce();
    expect(setMetrics).toHaveBeenCalledWith({ count: 4 });
    expect(hook.value.clearError).toBe('storage unavailable');
    expect(hook.value.isClearing).toBe(false);
  });

  it('includes a recovery read failure in the reported error', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const setMetrics = vi.fn();
    sendRuntimeMessage.mockRejectedValue(new Error('worker disconnected'));
    const hook = renderHook({
      messageType: 'clearMetrics',
      defaultErrorMessage: 'Clear failed',
      empty: () => ({ count: 0 }),
      read: vi.fn().mockRejectedValue(new Error('reload unavailable')),
      setMetrics,
    });

    await act(async () => hook.value.handleClear());

    expect(setMetrics).not.toHaveBeenCalled();
    expect(hook.value.clearError).toBe(
      'worker disconnected. Metrics could not be reloaded: reload unavailable',
    );
    expect(hook.value.isClearing).toBe(false);
  });
});
