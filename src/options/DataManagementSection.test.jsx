// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sendMessage = vi.hoisted(() => vi.fn());
vi.mock('./optionsApi.js', () => ({ sendMessage }));

import { DataManagementSection } from './DataManagementSection.jsx';

let container;
let root;
let confirmMock;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  sendMessage.mockReset();
  sendMessage.mockImplementation(async (msg) =>
    msg.type === 'getStorageOverview'
      ? { ok: true, overview: { categories: {}, totalBytes: 0, totalKeyCount: 0 } }
      : { ok: true },
  );
  confirmMock = vi.fn(() => true);
  vi.stubGlobal('confirm', confirmMock);
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

const findButton = (label) =>
  Array.from(container.querySelectorAll('button')).find((b) => b.textContent === label);

describe('DataManagementSection', () => {
  it('tells the user that deleting page data also cancels running processing', async () => {
    const onDataChanged = vi.fn();
    await act(async () => {
      root.render(<DataManagementSection onDataChanged={onDataChanged} />);
    });
    await act(async () => findButton('Delete all page data').click());
    expect(confirmMock).toHaveBeenCalledWith(
      expect.stringMatching(/running page processing.*cancelled/i),
    );
    expect(sendMessage).toHaveBeenCalledWith({ type: 'deleteAll' });
    expect(onDataChanged).toHaveBeenCalledWith();
  });

  it('flags a full reset as having changed providers', async () => {
    const onDataChanged = vi.fn();
    await act(async () => {
      root.render(<DataManagementSection onDataChanged={onDataChanged} />);
    });
    await act(async () => findButton('Delete all extension data').click());
    expect(onDataChanged).toHaveBeenCalledWith({ providersChanged: true });
  });
});
