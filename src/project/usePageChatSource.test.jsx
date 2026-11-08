// @vitest-environment happy-dom
import React, { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { usePageChatSource } from './usePageChatSource.js';

it('reloads when the URL changes for the same tab and loader', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  const root = createRoot(container);
  let latest;
  const loadSource = vi
    .fn()
    .mockResolvedValueOnce({ source: 'first' })
    .mockResolvedValueOnce({ source: 'second' });
  function Harness({ url }) {
    const value = usePageChatSource({ tabId: 7, url, loadSource });
    useEffect(() => {
      latest = value;
    });
    return null;
  }
  try {
    await act(async () => root.render(<Harness url="https://example.test/first" />));
    expect(latest).toMatchObject({ status: 'ready', source: 'first' });
    await act(async () => root.render(<Harness url="https://example.test/second" />));
    expect(loadSource).toHaveBeenCalledTimes(2);
    expect(loadSource).toHaveBeenLastCalledWith(7);
    expect(latest).toMatchObject({ status: 'ready', source: 'second' });
  } finally {
    act(() => root.unmount());
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});
