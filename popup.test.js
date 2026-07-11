// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeAll } from 'vitest';

beforeAll(() => {
  for (const id of [
    'pick-btn',
    'refresh-btn',
    'theme-btn',
    'open-options',
    'active-host',
    'records',
    'empty',
    'error',
    'record-count',
  ]) {
    const el = document.createElement('div');
    el.id = id;
    document.body.appendChild(el);
  }

  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage: vi.fn((msg, cb) => {
        cb({ ok: true, items: [] });
      }),
      lastError: null,
      openOptionsPage: vi.fn(),
      getURL: vi.fn((path) => path),
    },
    tabs: {
      sendMessage: vi.fn((tabId, msg, cb) => {
        cb({ status: 'ok' });
      }),
      query: vi.fn(() => Promise.resolve([])),
    },
    storage: {
      local: {
        get: vi.fn((keys, cb) => cb({})),
        set: vi.fn((items, cb) => cb && cb()),
      },
      onChanged: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
    },
  });
});

describe('popup pure functions', () => {
  let popup;

  beforeAll(async () => {
    popup = await import('./popup.js');
  });

  it('hostnameFromUrl extracts hostname', () => {
    expect(popup.hostnameFromUrl('https://example.com/path')).toBe('example.com');
  });

  it('hostnameFromUrl handles invalid URL', () => {
    expect(popup.hostnameFromUrl('not-a-url')).toBe('');
    expect(popup.hostnameFromUrl(null)).toBe('');
  });

  it('normalizePageUrl removes hash', () => {
    expect(popup.normalizePageUrl('https://example.com/page#section')).toBe(
      'https://example.com/page',
    );
  });

  it('normalizePageUrl handles missing URL', () => {
    expect(popup.normalizePageUrl('')).toBe('');
  });

  it('normalizePageUrl strips hash from malformed URL', () => {
    expect(popup.normalizePageUrl('bad-url#hash')).toBe('bad-url');
  });

  it('labelFromUrl prefers pathname', () => {
    expect(popup.labelFromUrl('https://example.com/path')).toBe('/path');
  });

  it('labelFromUrl falls back to hostname for root', () => {
    expect(popup.labelFromUrl('https://example.com/')).toBe('example.com');
  });

  it('labelFromUrl handles invalid URL', () => {
    expect(popup.labelFromUrl('not-a-url')).toBe('not-a-url');
  });

  it('statusLabel maps statuses', () => {
    expect(popup.statusLabel('done')).toBe('Done');
    expect(popup.statusLabel('pending')).toBe('Pending');
    expect(popup.statusLabel('splitting')).toBe('Processing');
    expect(popup.statusLabel('summarizing')).toBe('Processing');
    expect(popup.statusLabel('error')).toBe('Error');
    expect(popup.statusLabel('unknown')).toBe('unknown');
    expect(popup.statusLabel('')).toBe('Unknown');
  });

  it('formatDate formats timestamp', () => {
    const ts = new Date('2024-01-15T10:30:00Z').getTime();
    const formatted = popup.formatDate(ts);
    expect(formatted.length).toBeGreaterThan(0);
  });

  it('formatDate returns empty for falsy', () => {
    expect(popup.formatDate(0)).toBe('');
    expect(popup.formatDate(null)).toBe('');
  });

  it('providerConfigurationMessage explains missing providers', () => {
    expect(popup.providerConfigurationMessage({ providers: [], activeId: null })).toContain(
      'No LLM provider configured',
    );
  });

  it('providerConfigurationMessage explains missing active provider', () => {
    expect(
      popup.providerConfigurationMessage({ providers: [{ id: 'p1' }], activeId: null }),
    ).toContain('No active LLM provider selected');
  });

  it('providerConfigurationMessage returns empty when a provider is active', () => {
    expect(popup.providerConfigurationMessage({ providers: [{ id: 'p1' }], activeId: 'p1' })).toBe(
      '',
    );
  });

  it('providerReadinessState enables picking when provider state is active', () => {
    expect(
      popup.providerReadinessState({ ok: true, providers: [{ id: 'p1' }], activeId: 'p1' }),
    ).toEqual({
      ready: true,
      disabled: false,
      error: '',
    });
  });

  it('providerReadinessState reports backend and thrown provider errors', () => {
    expect(popup.providerReadinessState({ ok: false, error: 'Provider load failed' })).toEqual({
      ready: false,
      disabled: true,
      error: 'Provider load failed. Open Options and check your LLM provider configuration.',
    });
    expect(popup.providerReadinessState(null, new Error('Storage unavailable'))).toEqual({
      ready: false,
      disabled: true,
      error: 'Storage unavailable. Open Options and check your LLM provider configuration.',
    });
  });

  it('getRecordActions returns all view actions only for done records', () => {
    expect(popup.getRecordActions({ status: 'done' }).map((action) => action.label)).toEqual([
      'Canvas',
      'Hierarchy',
      'Topics',
      'Summaries',
      'Reprocess',
      'Export data',
      'Delete',
    ]);
    expect(popup.getRecordActions({ status: 'summarizing' }).map((action) => action.label)).toEqual(
      ['Canvas', 'Reprocess', 'Export data', 'Delete'],
    );
  });

  it('getRecordActions keeps stable modes and message types', () => {
    expect(popup.getRecordActions({ status: 'done' })).toEqual([
      expect.objectContaining({ kind: 'view', label: 'Canvas', mode: 'canvas' }),
      expect.objectContaining({ kind: 'view', label: 'Hierarchy', mode: 'hierarchy' }),
      expect.objectContaining({ kind: 'view', label: 'Topics', mode: 'topics' }),
      expect.objectContaining({ kind: 'view', label: 'Summaries', mode: 'summaries' }),
      expect.objectContaining({
        kind: 'message',
        label: 'Reprocess',
        messageType: 'reprocessRecord',
      }),
      expect.objectContaining({ kind: 'export', label: 'Export data', messageType: 'getRecord' }),
      expect.objectContaining({ kind: 'message', label: 'Delete', messageType: 'deleteRecord' }),
    ]);
  });

  it('getRecordActions offers Generate summaries only for done records without summaries', () => {
    expect(
      popup
        .getRecordActions({ status: 'done', summariesDisabled: true })
        .map((action) => action.label),
    ).toEqual([
      'Canvas',
      'Hierarchy',
      'Topics',
      'Summaries',
      'Reprocess',
      'Generate summaries',
      'Export data',
      'Delete',
    ]);
    expect(
      popup
        .getRecordActions({ status: 'done', summariesDisabled: true })
        .find((action) => action.label === 'Generate summaries'),
    ).toEqual(
      expect.objectContaining({
        kind: 'message',
        messageType: 'generateRecordSummaries',
      }),
    );
    // Not offered when summaries already ran, or while still processing.
    expect(
      popup.getRecordActions({ status: 'done', summariesDisabled: false }).map((a) => a.label),
    ).not.toContain('Generate summaries');
    expect(
      popup
        .getRecordActions({ status: 'summarizing', summariesDisabled: true })
        .map((a) => a.label),
    ).not.toContain('Generate summaries');
  });

  it('getRecordActions adds a YT Sync view for done YouTube records', () => {
    const labels = popup
      .getRecordActions({ status: 'done', sourceUrl: 'https://www.youtube.com/watch?v=abc123' })
      .map((action) => action.label);
    expect(labels).toEqual([
      'Canvas',
      'Hierarchy',
      'Topics',
      'Summaries',
      'YT Sync',
      'Reprocess',
      'Export data',
      'Delete',
    ]);
    expect(
      popup
        .getRecordActions({ status: 'done', sourceUrl: 'https://www.youtube.com/watch?v=abc123' })
        .find((action) => action.label === 'YT Sync'),
    ).toEqual(expect.objectContaining({ kind: 'view', mode: 'youtube' }));
  });

  it('getRecordActions omits YT Sync for non-YouTube or unfinished records', () => {
    expect(
      popup
        .getRecordActions({ status: 'done', sourceUrl: 'https://example.com/page' })
        .map((a) => a.label),
    ).not.toContain('YT Sync');
    expect(
      popup
        .getRecordActions({ status: 'summarizing', sourceUrl: 'https://youtu.be/abc123' })
        .map((a) => a.label),
    ).not.toContain('YT Sync');
  });

  it('isYouTubeUrl recognizes watch, youtu.be, shorts and rejects others', () => {
    expect(popup.isYouTubeUrl('https://www.youtube.com/watch?v=abc123')).toBe(true);
    expect(popup.isYouTubeUrl('https://youtu.be/abc123')).toBe(true);
    expect(popup.isYouTubeUrl('https://m.youtube.com/shorts/xyz')).toBe(true);
    expect(popup.isYouTubeUrl('https://music.youtube.com/watch?v=abc')).toBe(true);
    expect(popup.isYouTubeUrl('https://www.youtube.com/watch')).toBe(false);
    expect(popup.isYouTubeUrl('https://example.com/watch?v=abc')).toBe(false);
    expect(popup.isYouTubeUrl('not-a-url')).toBe(false);
    expect(popup.isYouTubeUrl('')).toBe(false);
  });

  it('getYouTubeVideoId extracts ids without depending on unrelated params', () => {
    expect(popup.getYouTubeVideoId('https://www.youtube.com/watch?v=VZTmS4B840k&t=420s')).toBe(
      'VZTmS4B840k',
    );
    expect(popup.getYouTubeVideoId('https://www.youtube.com/watch?t=420s&v=VZTmS4B840k')).toBe(
      'VZTmS4B840k',
    );
    expect(
      popup.getYouTubeVideoId('https://www.youtube.com/watch?v=VZTmS4B840k&list=playlist-id'),
    ).toBe('VZTmS4B840k');
    expect(popup.getYouTubeVideoId('https://youtu.be/VZTmS4B840k?t=420')).toBe('VZTmS4B840k');
    expect(popup.getYouTubeVideoId('https://example.com/watch?v=VZTmS4B840k')).toBeNull();
  });

  it('filterRecordsForActivePage matches hash-normalized source URLs', () => {
    const records = [
      { key: 'a', sourceUrl: 'https://example.com/page#one' },
      { key: 'b', sourceUrl: 'https://example.com/other' },
      { key: 'c', sourceUrl: 'not-a-url#hash' },
    ];
    expect(
      popup.filterRecordsForActivePage(records, 'https://example.com/page').map((r) => r.key),
    ).toEqual(['a']);
    expect(popup.filterRecordsForActivePage(records, '').map((r) => r.key)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('filterRecordsForActivePage matches YouTube records by video id', () => {
    const records = [
      { key: 'watch', sourceUrl: 'https://www.youtube.com/watch?v=VZTmS4B840k' },
      { key: 'timestamp', sourceUrl: 'https://www.youtube.com/watch?v=VZTmS4B840k&t=420s' },
      { key: 'playlist', sourceUrl: 'https://www.youtube.com/watch?v=VZTmS4B840k&list=list-id' },
      { key: 'short', sourceUrl: 'https://youtu.be/VZTmS4B840k?si=share-id' },
      { key: 'other', sourceUrl: 'https://www.youtube.com/watch?v=other' },
      { key: 'non-youtube', sourceUrl: 'https://example.com/watch?v=VZTmS4B840k' },
    ];

    expect(
      popup
        .filterRecordsForActivePage(
          records,
          'https://www.youtube.com/watch?v=VZTmS4B840k&t=999s&list=another-list',
        )
        .map((r) => r.key),
    ).toEqual(['watch', 'timestamp', 'playlist', 'short']);
  });

  it('filterRecordsForActivePage keeps exact query matching for non-YouTube URLs', () => {
    const records = [
      { key: 'same', sourceUrl: 'https://example.com/watch?v=abc&t=420s' },
      { key: 'different-query', sourceUrl: 'https://example.com/watch?v=abc' },
    ];

    expect(
      popup
        .filterRecordsForActivePage(records, 'https://example.com/watch?v=abc&t=420s')
        .map((r) => r.key),
    ).toEqual(['same']);
  });

  it('getActiveTab returns first active tab', async () => {
    chrome.tabs.query.mockResolvedValue([{ id: 1, url: 'https://example.com' }]);
    const tab = await popup.getActiveTab();
    expect(tab.id).toBe(1);
  });

  it('getActiveTab returns null when no tabs', async () => {
    chrome.tabs.query.mockResolvedValue([]);
    const tab = await popup.getActiveTab();
    expect(tab).toBeNull();
  });

  it('runtimeMessage resolves on success', async () => {
    chrome.runtime.sendMessage.mockImplementation((msg, cb) => {
      cb({ ok: true });
    });
    const res = await popup.runtimeMessage({ type: 'test' });
    expect(res.ok).toBe(true);
  });

  it('runtimeMessage rejects on lastError', async () => {
    chrome.runtime.sendMessage.mockImplementation((msg, cb) => {
      chrome.runtime.lastError = { message: 'fail' };
      cb();
      chrome.runtime.lastError = null;
    });
    await expect(popup.runtimeMessage({ type: 'test' })).rejects.toThrow('fail');
  });

  it('tabMessage resolves on success', async () => {
    chrome.tabs.sendMessage.mockImplementation((tabId, msg, cb) => {
      cb({ status: 'ok' });
    });
    const res = await popup.tabMessage(1, { action: 'test' });
    expect(res.status).toBe('ok');
  });

  it('tabMessage rejects on lastError', async () => {
    chrome.tabs.sendMessage.mockImplementation((tabId, msg, cb) => {
      chrome.runtime.lastError = { message: 'closed' };
      cb();
      chrome.runtime.lastError = null;
    });
    await expect(popup.tabMessage(1, { action: 'test' })).rejects.toThrow('closed');
  });

  it('responseErrorMessage prefers response.error then fallback', () => {
    expect(popup.responseErrorMessage({ error: 'boom' }, 'fb')).toBe('boom');
    expect(popup.responseErrorMessage({ ok: true }, 'fb')).toBe('fb');
    expect(popup.responseErrorMessage(null, 'fb')).toBe('fb');
    expect(popup.responseErrorMessage(undefined, 'def')).toBe('def');
  });
});

describe('setupThemeToggle', () => {
  let popup;

  beforeAll(async () => {
    popup = await import('./popup.js');
  });

  function fakeController() {
    let subscriber = null;
    return {
      preference: 'system',
      cycled: 0,
      subscribe(fn) {
        subscriber = fn;
        fn({ preference: this.preference, allowSystem: true });
        return () => {};
      },
      cycle() {
        this.cycled += 1;
        this.preference = 'light';
        if (subscriber) subscriber({ preference: this.preference, allowSystem: true });
        return Promise.resolve();
      },
      init: vi.fn().mockResolvedValue(undefined),
    };
  }

  it('renders the current preference and cycles on click', () => {
    const themeBtn = document.getElementById('theme-btn');
    const controller = fakeController();
    popup.setupThemeToggle(controller);

    expect(controller.init).toHaveBeenCalled();
    expect(themeBtn.getAttribute('aria-label')).toContain('System');

    themeBtn.click();
    expect(controller.cycled).toBe(1);
    expect(themeBtn.getAttribute('aria-label')).toContain('Light');
  });
});

describe('handleMessageAction', () => {
  let popup;

  beforeAll(async () => {
    popup = await import('./popup.js');
  });

  const makeAction = (overrides = {}) => ({
    confirmMessage: 'Confirm?',
    messageType: 'doSomething',
    failureMessage: 'Action failed',
    ...overrides,
  });

  it('does nothing when user cancels confirm', async () => {
    const runtimeMessage = vi.fn();
    const onSuccess = vi.fn();
    const onError = vi.fn();
    await popup.handleMessageAction(makeAction(), 'k1', {
      confirm: () => false,
      runtimeMessage,
      onSuccess,
      onError,
    });
    expect(runtimeMessage).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('skips confirm when action has no confirmMessage', async () => {
    const confirm = vi.fn();
    const runtimeMessage = vi.fn().mockResolvedValue({ ok: true });
    const onSuccess = vi.fn();
    await popup.handleMessageAction(makeAction({ confirmMessage: undefined }), 'k1', {
      confirm,
      runtimeMessage,
      onSuccess,
      onError: vi.fn(),
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(runtimeMessage).toHaveBeenCalledWith({ type: 'doSomething', key: 'k1' });
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it('calls onSuccess when response is ok', async () => {
    const runtimeMessage = vi.fn().mockResolvedValue({ ok: true });
    const onSuccess = vi.fn().mockResolvedValue(undefined);
    const onError = vi.fn();
    await popup.handleMessageAction(makeAction(), 'k1', {
      confirm: () => true,
      runtimeMessage,
      onSuccess,
      onError,
    });
    expect(runtimeMessage).toHaveBeenCalledWith({ type: 'doSomething', key: 'k1' });
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it('calls onError with derived message when response is not ok', async () => {
    const runtimeMessage = vi.fn().mockResolvedValue({ ok: false, error: 'Server error' });
    const onSuccess = vi.fn();
    const onError = vi.fn();
    await popup.handleMessageAction(makeAction({ failureMessage: 'Action failed' }), 'k1', {
      confirm: () => true,
      runtimeMessage,
      onSuccess,
      onError,
    });
    expect(onError).toHaveBeenCalledWith('Server error');
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('calls onError with failureMessage when response has no error field', async () => {
    const runtimeMessage = vi.fn().mockResolvedValue({ ok: false });
    const onError = vi.fn();
    await popup.handleMessageAction(makeAction({ failureMessage: 'Custom fallback' }), 'k2', {
      confirm: () => true,
      runtimeMessage,
      onSuccess: vi.fn(),
      onError,
    });
    expect(onError).toHaveBeenCalledWith('Custom fallback');
  });

  it('calls onError with null response using failureMessage', async () => {
    const runtimeMessage = vi.fn().mockResolvedValue(null);
    const onError = vi.fn();
    await popup.handleMessageAction(makeAction({ failureMessage: 'Null fallback' }), 'k3', {
      confirm: () => true,
      runtimeMessage,
      onSuccess: vi.fn(),
      onError,
    });
    expect(onError).toHaveBeenCalledWith('Null fallback');
  });

  it('calls onError with err.message when runtimeMessage throws an Error', async () => {
    const runtimeMessage = vi.fn().mockRejectedValue(new Error('network down'));
    const onError = vi.fn();
    await popup.handleMessageAction(makeAction(), 'k4', {
      confirm: () => true,
      runtimeMessage,
      onSuccess: vi.fn(),
      onError,
    });
    expect(onError).toHaveBeenCalledWith('network down');
  });

  it('calls onError with String(err) when thrown value has no message', async () => {
    const runtimeMessage = vi.fn().mockRejectedValue('just a string error');
    const onError = vi.fn();
    await popup.handleMessageAction(makeAction(), 'k5', {
      confirm: () => true,
      runtimeMessage,
      onSuccess: vi.fn(),
      onError,
    });
    expect(onError).toHaveBeenCalledWith('just a string error');
  });
});

describe('buildRecordDisplayData', () => {
  let popup;

  beforeAll(async () => {
    popup = await import('./popup.js');
  });

  it('returns empty state for empty array', () => {
    const result = popup.buildRecordDisplayData([]);
    expect(result.count).toBe(0);
    expect(result.isEmpty).toBe(true);
    expect(result.records).toEqual([]);
  });

  it('returns correct count and isEmpty=false for non-empty array', () => {
    const records = [
      { key: 'a', sourceUrl: 'https://example.com/page', createdAt: 0, status: 'done' },
    ];
    const result = popup.buildRecordDisplayData(records);
    expect(result.count).toBe(1);
    expect(result.isEmpty).toBe(false);
  });

  it('shapes a done record correctly', () => {
    const records = [
      {
        key: 'rec1',
        sourceUrl: 'https://example.com/path',
        snippet: 'A short preview of the selected document.',
        createdAt: 0,
        status: 'done',
      },
    ];
    const result = popup.buildRecordDisplayData(records);
    const r = result.records[0];
    expect(r.key).toBe('rec1');
    expect(r.label).toBe('/path');
    expect(r.sourceUrl).toBe('https://example.com/path');
    expect(r.snippet).toBe('A short preview of the selected document.');
    expect(r.status).toBe('done');
    expect(r.badge).toBe('Done');
    expect(Array.isArray(r.actions)).toBe(true);
    expect(r.actions.length).toBeGreaterThan(0);
  });

  it('handles a record with missing sourceUrl', () => {
    const records = [{ key: 'r2', createdAt: 0, status: 'pending' }];
    const result = popup.buildRecordDisplayData(records);
    const r = result.records[0];
    expect(r.label).toBe('Unknown page');
    expect(r.sourceUrl).toBe('');
    expect(r.badge).toBe('Pending');
  });

  it('handles unknown status', () => {
    const records = [{ key: 'r3', sourceUrl: 'https://x.com/', createdAt: 0, status: 'weird' }];
    const result = popup.buildRecordDisplayData(records);
    const r = result.records[0];
    expect(r.status).toBe('weird');
    expect(r.badge).toBe('weird');
  });

  it('handles non-array input gracefully', () => {
    const result = popup.buildRecordDisplayData(null);
    expect(result.count).toBe(0);
    expect(result.isEmpty).toBe(true);
    expect(result.records).toEqual([]);
  });

  it('includes all four view actions for done records', () => {
    const records = [{ key: 'r4', sourceUrl: 'https://x.com/', createdAt: 0, status: 'done' }];
    const result = popup.buildRecordDisplayData(records);
    const viewActions = result.records[0].actions.filter((a) => a.kind === 'view');
    expect(viewActions.map((a) => a.mode)).toEqual(['canvas', 'hierarchy', 'topics', 'summaries']);
  });

  it('includes only canvas view action for non-done records', () => {
    const records = [
      { key: 'r5', sourceUrl: 'https://x.com/', createdAt: 0, status: 'summarizing' },
    ];
    const result = popup.buildRecordDisplayData(records);
    const viewActions = result.records[0].actions.filter((a) => a.kind === 'view');
    expect(viewActions.map((a) => a.mode)).toEqual(['canvas']);
  });
});

describe('popup UI integration', () => {
  beforeAll(async () => {
    await import('./popup.js');
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  const sampleRecord = {
    key: 'rec1',
    sourceUrl: 'https://example.com/article',
    createdAt: 1_700_000_000_000,
    status: 'done',
    snippet: 'A short snippet',
  };

  async function waitForRecord() {
    let record = null;
    for (let i = 0; i < 50; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      record = document.querySelector('#records .record');
      if (record) break;
    }
    return record;
  }

  function stubListResponses(items = [sampleRecord]) {
    chrome.runtime.sendMessage.mockImplementation((msg, cb) => {
      if (msg.type === 'listRecords') {
        cb({ ok: true, items });
      } else if (msg.type === 'listProviders') {
        cb({
          ok: true,
          providers: [
            { id: 'p1', name: 'OpenAI', type: 'openai', model: 'gpt-4o', hasToken: true },
          ],
          activeId: 'p1',
        });
      } else {
        cb({ ok: true });
      }
    });
    chrome.tabs.query.mockResolvedValue([{ id: 42, url: 'https://example.com/article' }]);
  }

  it('renders matching records with snippets and action buttons on refresh', async () => {
    stubListResponses();
    document.getElementById('error').textContent = '';
    document.getElementById('refresh-btn').click();

    const record = await waitForRecord();
    expect(record).not.toBeNull();
    expect(record.querySelector('.snippet').textContent).toBe('A short snippet');
    expect(record.querySelectorAll('.action').length).toBeGreaterThan(1);
    expect(document.getElementById('empty').hidden).toBe(true);
    expect(document.getElementById('record-count').textContent).toBe('1');
  });

  it('shows an error when listRecords returns a failed response', async () => {
    chrome.runtime.sendMessage.mockImplementation((msg, cb) => {
      if (msg.type === 'listRecords') cb({ ok: false, error: 'backend down' });
      else cb({ ok: true });
    });
    chrome.tabs.query.mockResolvedValue([{ id: 42, url: 'https://example.com/article' }]);

    document.getElementById('refresh-btn').click();
    let message = '';
    for (let i = 0; i < 50; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      message = document.getElementById('error').textContent;
      if (message.includes('backend down')) break;
    }

    expect(message).toContain('backend down');
    expect(document.getElementById('records').children.length).toBe(0);
  });

  it('starts selection when pick is clicked and a provider is ready', async () => {
    stubListResponses([]);
    document.getElementById('refresh-btn').click();
    await waitForRecord().catch(() => null);
    chrome.tabs.sendMessage.mockClear();

    document.getElementById('pick-btn').disabled = false;
    document.getElementById('pick-btn').click();

    let called = false;
    for (let i = 0; i < 50; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (chrome.tabs.sendMessage.mock.calls.length > 0) {
        called = true;
        break;
      }
    }

    expect(called).toBe(true);
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      42,
      { action: 'startSelection' },
      expect.any(Function),
    );
  });

  it('opens the options page from the options link', () => {
    chrome.runtime.openOptionsPage.mockClear();
    document
      .getElementById('open-options')
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(chrome.runtime.openOptionsPage).toHaveBeenCalled();
  });
});
