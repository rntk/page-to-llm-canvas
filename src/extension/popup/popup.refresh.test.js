// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  afterEach(() => vi.unstubAllGlobals());

  beforeEach(() => {
    vi.resetModules();
    installPopupDom();
    installChrome();
  });

  it('deletes a record only after accepting the in-popup confirmation and refreshes the list', async () => {
    chrome.tabs.query.mockResolvedValue([{ id: 1, url: records[0].sourceUrl }]);
    const nativeConfirm = vi.fn(() => false);
    vi.stubGlobal('confirm', nativeConfirm);
    let savedRecords = [records[0]];
    chrome.runtime.sendMessage.mockImplementation((message, callback) => {
      if (message.type === 'listRecords') callback({ ok: true, items: savedRecords });
      else if (message.type === 'listProviders') {
        callback({ ok: true, providers: [{ id: 'provider-1' }], activeId: 'provider-1' });
      } else if (message.type === 'deleteRecord') {
        savedRecords = [];
        callback({ ok: true });
      }
    });

    await import('./popup.js');
    await vi.waitFor(() => expect(document.querySelectorAll('#records .record')).toHaveLength(1));
    const deleteButton = [...document.querySelectorAll('#records button')].find(
      (button) => button.textContent === 'Delete',
    );
    deleteButton.click();
    const dialog = document.querySelector('dialog');
    expect(dialog.open).toBe(true);
    expect(dialog.textContent).toContain('Delete this record?');
    expect(savedRecords).toHaveLength(1);
    expect(nativeConfirm).not.toHaveBeenCalled();
    dialog.querySelector('.danger').click();

    await vi.waitFor(() => expect(document.querySelectorAll('#records .record')).toHaveLength(0));
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      { type: 'deleteRecord', key: 'old-record' },
      expect.any(Function),
    );
    expect(document.getElementById('empty').hidden).toBe(false);
    expect(document.querySelector('dialog')).toBeNull();
  });

  it.each(['Cancel', 'Escape'])(
    'keeps the record when confirmation is dismissed with %s',
    async (dismissal) => {
      chrome.tabs.query.mockResolvedValue([{ id: 1, url: records[0].sourceUrl }]);
      await import('./popup.js');
      await vi.waitFor(() => expect(document.querySelectorAll('#records .record')).toHaveLength(1));
      const deleteButton = [...document.querySelectorAll('#records button')].find(
        (button) => button.textContent === 'Delete',
      );
      deleteButton.click();
      const dialog = document.querySelector('dialog');
      if (dismissal === 'Cancel') dialog.querySelector('button').click();
      else dialog.dispatchEvent(new Event('cancel', { cancelable: true }));

      await vi.waitFor(() => expect(deleteButton.disabled).toBe(false));
      expect(document.querySelector('dialog')).toBeNull();
      expect(document.querySelectorAll('#records .record')).toHaveLength(1);
      expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'deleteRecord' }),
        expect.any(Function),
      );
      expect(document.activeElement).toBe(deleteButton);
    },
  );

  it('restores focus after a non-confirming action fails', async () => {
    chrome.tabs.query.mockResolvedValue([{ id: 1, url: records[0].sourceUrl }]);
    const defaultSendMessage = chrome.runtime.sendMessage.getMockImplementation();
    let completeAction;
    chrome.runtime.sendMessage.mockImplementation((message, callback) => {
      if (message.type === 'listRecords') {
        callback({ ok: true, items: [{ ...records[0], summariesDisabled: true }] });
      } else if (message.type === 'generateRecordSummaries') {
        completeAction = callback;
      } else defaultSendMessage(message, callback);
    });

    await import('./popup.js');
    await vi.waitFor(() => expect(document.querySelectorAll('#records .record')).toHaveLength(1));
    const button = [...document.querySelectorAll('#records button')].find(
      (element) => element.textContent === 'Generate summaries',
    );
    button.focus();
    button.click();
    expect(button.disabled).toBe(true);
    // Model Chrome blurring a disabled button; happy-dom retains focus here.
    button.blur();
    completeAction({ ok: false, error: 'Summary generation failed' });

    await vi.waitFor(() => expect(button.disabled).toBe(false));
    expect(document.getElementById('error').textContent).toBe('Summary generation failed');
    expect(document.activeElement).toBe(button);
  });

  it('shows an initial active-tab lookup failure through the popup error state', async () => {
    chrome.tabs.query.mockRejectedValue(new Error('Unable to inspect the active tab'));

    await import('./popup.js');

    await waitForText('error', 'Unable to inspect the active tab');
    expect(document.getElementById('error').hidden).toBe(false);
    expect(document.getElementById('records').children).toHaveLength(0);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'listRecords' }),
      expect.any(Function),
    );
  });

  it('starts tab, record, and provider lookups before any of them resolves', async () => {
    let resolveTabQuery;
    chrome.tabs.query.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveTabQuery = resolve;
        }),
    );

    await import('./popup.js');

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'listRecords' }),
      expect.any(Function),
    );
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'listProviders' }),
      expect.any(Function),
    );

    resolveTabQuery([{ id: 1, url: 'https://new.example/article' }]);
    await waitForText('active-host', 'new.example');
  });

  it('updates the hostname before reporting a records request failure', async () => {
    chrome.tabs.query.mockResolvedValueOnce([{ id: 1, url: 'https://old.example/article' }]);
    await import('./popup.js');
    await waitForText('active-host', 'old.example');

    chrome.tabs.query.mockResolvedValueOnce([{ id: 2, url: 'https://new.example/article' }]);
    chrome.runtime.sendMessage.mockImplementation((message, callback) => {
      if (message.type === 'listRecords') {
        chrome.runtime.lastError = { message: 'Records request failed' };
        callback();
        chrome.runtime.lastError = null;
      } else if (message.type === 'listProviders') {
        callback({ ok: true, providers: [{ id: 'provider-1' }], activeId: 'provider-1' });
      }
    });

    document.getElementById('refresh-btn').click();

    await waitForText('error', 'Records request failed');
    expect(document.getElementById('active-host').textContent).toBe('new.example');
    expect(document.getElementById('active-host').title).toBe('https://new.example/article');
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

  it('debounces relevant record storage changes and ignores unrelated keys and areas', async () => {
    chrome.tabs.query.mockResolvedValue([{ id: 1, url: records[0].sourceUrl }]);
    await import('./popup.js');
    await vi.waitFor(() => expect(document.querySelectorAll('#records .record')).toHaveLength(1));
    const initialListCalls = chrome.runtime.sendMessage.mock.calls.filter(
      ([message]) => message.type === 'listRecords',
    ).length;
    const listener = chrome.storage.onChanged.addListener.mock.calls[0][0];
    vi.useFakeTimers();

    listener({ 'pagetollm:chats:record:index': { newValue: {} } }, 'local');
    listener({ 'pagetollm:llm:providers': { newValue: {} } }, 'local');
    listener({ 'pagetollm:rec:record:meta': { newValue: {} } }, 'sync');
    await vi.advanceTimersByTimeAsync(500);
    expect(
      chrome.runtime.sendMessage.mock.calls.filter(([message]) => message.type === 'listRecords'),
    ).toHaveLength(initialListCalls);

    listener({ 'pagetollm:index': { newValue: {} } }, 'local');
    listener({ 'pagetollm:rec:record:meta': { newValue: {} } }, 'local');
    await vi.advanceTimersByTimeAsync(299);
    expect(
      chrome.runtime.sendMessage.mock.calls.filter(([message]) => message.type === 'listRecords'),
    ).toHaveLength(initialListCalls);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() =>
      expect(
        chrome.runtime.sendMessage.mock.calls.filter(([message]) => message.type === 'listRecords'),
      ).toHaveLength(initialListCalls + 1),
    );
    vi.useRealTimers();
  });

  it('refreshes records when session pipeline failure state changes', async () => {
    chrome.tabs.query.mockResolvedValue([{ id: 1, url: records[0].sourceUrl }]);
    await import('./popup.js');
    await vi.waitFor(() => expect(document.querySelectorAll('#records .record')).toHaveLength(1));
    const initialListCalls = chrome.runtime.sendMessage.mock.calls.filter(
      ([message]) => message.type === 'listRecords',
    ).length;
    const listener = chrome.storage.onChanged.addListener.mock.calls[0][0];
    vi.useFakeTimers();

    listener({ 'pagetollm:pipeline-failure-breakers': { newValue: {} } }, 'session');
    await vi.advanceTimersByTimeAsync(300);
    await vi.waitFor(() =>
      expect(
        chrome.runtime.sendMessage.mock.calls.filter(([message]) => message.type === 'listRecords'),
      ).toHaveLength(initialListCalls + 1),
    );
    vi.useRealTimers();
  });

  it('shows a pick-button error when the active-tab lookup rejects', async () => {
    await import('./popup.js');
    await vi.waitFor(() => expect(chrome.tabs.query).toHaveBeenCalled());
    chrome.tabs.query.mockRejectedValueOnce(new Error('Active tab lookup failed'));
    document.getElementById('pick-btn').click();
    await waitForText('error', 'Unable to start selection on this page.');
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
  });

  it('shows a pick-button error when sending the selection message rejects', async () => {
    chrome.tabs.query.mockResolvedValue([{ id: 1, url: records[0].sourceUrl }]);
    await import('./popup.js');
    await vi.waitFor(() =>
      expect(document.getElementById('active-host').textContent).toBe('old.example'),
    );
    chrome.tabs.sendMessage.mockImplementationOnce((_tabId, _message, callback) => {
      chrome.runtime.lastError = { message: 'Could not establish connection' };
      callback();
      chrome.runtime.lastError = null;
    });

    document.getElementById('pick-btn').click();

    await waitForText('error', 'Unable to start selection on this page.');
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      1,
      { action: 'startSelection' },
      expect.any(Function),
    );
  });

  it('shows an error returned by the content script when starting selection', async () => {
    chrome.tabs.query.mockResolvedValue([{ id: 1, url: records[0].sourceUrl }]);
    await import('./popup.js');
    await vi.waitFor(() =>
      expect(document.getElementById('active-host').textContent).toBe('old.example'),
    );
    chrome.tabs.sendMessage.mockImplementationOnce((_tabId, _message, callback) =>
      callback({ status: 'error', error: 'Selection is unavailable on this page' }),
    );

    document.getElementById('pick-btn').click();

    await waitForText('error', 'Selection is unavailable on this page');
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      1,
      { action: 'startSelection' },
      expect.any(Function),
    );
  });
});
