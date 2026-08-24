// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installPopupDom } from '../../../test/fakes/popupDomFake.mjs';

const records = [
  {
    key: 'old-record',
    sourceUrl: 'https://old.example/article',
    createdAt: 1,
    status: 'done',
  },
  {
    key: 'new-record',
    sourceUrl: 'https://new.example/article',
    createdAt: 2,
    status: 'done',
  },
];

function installChrome() {
  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage: vi.fn((message, callback) => {
        if (message.type === 'listRecords') callback({ ok: true, items: records });
        else if (message.type === 'listProviders') {
          callback({ ok: true, providers: [{ id: 'provider-1' }], activeId: 'provider-1' });
        } else callback({ ok: true });
      }),
      lastError: null,
      openOptionsPage: vi.fn(),
      getURL: vi.fn((path) => path),
    },
    tabs: {
      query: vi.fn(),
      sendMessage: vi.fn((_tabId, _message, callback) => callback({ status: 'ok' })),
    },
    storage: {
      local: {
        get: vi.fn((_keys, callback) => callback({})),
        set: vi.fn((_items, callback) => callback?.()),
      },
      onChanged: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
    },
  });
}

async function waitForText(id, expected) {
  await vi.waitFor(() => expect(document.getElementById(id).textContent).toBe(expected));
}

describe('popup refresh integration', () => {
  beforeEach(() => {
    vi.resetModules();
    installPopupDom();
    installChrome();
  });

  it('shows an initial active-tab lookup failure through the popup error state', async () => {
    chrome.tabs.query.mockRejectedValue(new Error('Unable to inspect the active tab'));

    await import('./popup.js');

    await waitForText('error', 'Unable to inspect the active tab');
    expect(document.getElementById('error').hidden).toBe(false);
    expect(document.getElementById('records').children).toHaveLength(0);
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'listRecords' }),
      expect.any(Function),
    );
  });

  it('renders the no-active-tab fallback without treating it as an error', async () => {
    chrome.tabs.query.mockResolvedValue([]);

    await import('./popup.js');

    await waitForText('active-host', 'Current page');
    expect(document.getElementById('active-host').title).toBe('');
    expect(document.getElementById('error').textContent).toBe('');
    expect(document.getElementById('error').hidden).toBe(true);
    await vi.waitFor(() => expect(document.querySelectorAll('#records .record')).toHaveLength(2));
  });

  it('updates active-page details and reports a later refresh lookup failure', async () => {
    chrome.tabs.query.mockResolvedValueOnce([
      { id: 1, url: 'https://old.example/article#section' },
    ]);

    await import('./popup.js');

    await waitForText('active-host', 'old.example');
    expect(document.getElementById('active-host').title).toBe(
      'https://old.example/article#section',
    );
    await vi.waitFor(() =>
      expect(document.querySelector('#records .label')?.textContent).toBe('/article'),
    );

    chrome.tabs.query.mockRejectedValueOnce(new Error('Tab query failed during refresh'));
    document.getElementById('refresh-btn').click();

    await waitForText('error', 'Tab query failed during refresh');
    expect(document.getElementById('records').children).toHaveLength(0);
    expect(document.getElementById('record-count').textContent).toBe('');
  });

  it('does not let a stale tab query replace the tab selected by a newer refresh', async () => {
    chrome.tabs.query.mockResolvedValueOnce([{ id: 1, url: 'https://old.example/article' }]);
    await import('./popup.js');
    await waitForText('active-host', 'old.example');

    let resolveStaleQuery;
    chrome.tabs.query
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveStaleQuery = resolve;
          }),
      )
      .mockResolvedValueOnce([{ id: 2, url: 'https://new.example/article' }]);

    document.getElementById('refresh-btn').click();
    document.getElementById('refresh-btn').click();
    await waitForText('active-host', 'new.example');
    await vi.waitFor(() =>
      expect(document.querySelector('#records .label')?.title).toBe('https://new.example/article'),
    );

    resolveStaleQuery([{ id: 99, url: 'https://stale.example/article' }]);
    await Promise.resolve();
    await Promise.resolve();

    chrome.tabs.sendMessage.mockClear();
    document.getElementById('pick-btn').click();
    await vi.waitFor(() => expect(chrome.tabs.sendMessage).toHaveBeenCalledTimes(1));
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      2,
      { action: 'startSelection' },
      expect.any(Function),
    );
    expect(document.getElementById('active-host').textContent).toBe('new.example');
  });
});
