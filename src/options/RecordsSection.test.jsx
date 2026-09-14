// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listRecords = vi.hoisted(() => vi.fn());
const sendMessage = vi.hoisted(() => vi.fn());
vi.mock('./optionsApi.js', () => ({ listRecords, sendMessage }));

import { RecordsSection } from './RecordsSection.jsx';

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  listRecords.mockReset();
  sendMessage.mockReset();
  listRecords.mockResolvedValue({ items: [], error: null });
});

afterEach(() => {
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

function staticHosts() {
  return {
    fileHost: { readJson: vi.fn(), downloadJson: vi.fn() },
    pageHost: {
      confirm: vi.fn(() => true),
      alert: vi.fn(),
      openExtensionPage: vi.fn(() => false),
    },
  };
}

describe('RecordsSection subscription', () => {
  it('subscribes once and loads once across re-renders with a fresh subscribeRecords identity', async () => {
    const subscribe = vi.fn(() => vi.fn());
    const hosts = staticHosts();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    // Each render passes a brand-new inline closure, like a caller that
    // doesn't stabilize the capability.
    const renderWithFreshClosure = () =>
      root.render(
        <RecordsSection
          fileHost={hosts.fileHost}
          pageHost={hosts.pageHost}
          subscribeRecords={(onChange) => subscribe(onChange)}
        />,
      );

    await act(async () => {
      renderWithFreshClosure();
    });
    await act(async () => {
      renderWithFreshClosure();
      renderWithFreshClosure();
    });

    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(listRecords).toHaveBeenCalledTimes(1);

    const [unsubscribe] = subscribe.mock.results.map((result) => result.value);
    await act(async () => {
      root.unmount();
    });
    expect(unsubscribe).toHaveBeenCalledOnce();
    container.remove();
  });

  it('unmounts safely when subscribeRecords does not return an unsubscribe function', async () => {
    const subscribe = vi.fn(() => undefined);
    const hosts = staticHosts();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <RecordsSection
          fileHost={hosts.fileHost}
          pageHost={hosts.pageHost}
          subscribeRecords={subscribe}
        />,
      );
    });

    expect(() => {
      act(() => {
        root.unmount();
      });
    }).not.toThrow();
    container.remove();
  });
});
