// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeAll } from 'vitest';

beforeAll(() => {
  for (const id of [
    'pick-btn',
    'refresh-btn',
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
      'Topics',
      'Summaries',
      'Hierarchy',
      'Reprocess',
      'Delete',
    ]);
    expect(popup.getRecordActions({ status: 'summarizing' }).map((action) => action.label)).toEqual(
      ['Canvas', 'Reprocess', 'Delete'],
    );
  });

  it('getRecordActions keeps stable modes and message types', () => {
    expect(popup.getRecordActions({ status: 'done' })).toEqual([
      expect.objectContaining({ kind: 'view', label: 'Canvas', mode: 'canvas' }),
      expect.objectContaining({ kind: 'view', label: 'Topics', mode: 'topics' }),
      expect.objectContaining({ kind: 'view', label: 'Summaries', mode: 'summaries' }),
      expect.objectContaining({ kind: 'view', label: 'Hierarchy', mode: 'hierarchy' }),
      expect.objectContaining({
        kind: 'message',
        label: 'Reprocess',
        messageType: 'reprocessRecord',
      }),
      expect.objectContaining({ kind: 'message', label: 'Delete', messageType: 'deleteRecord' }),
    ]);
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
    expect(viewActions.map((a) => a.mode)).toEqual(['canvas', 'topics', 'summaries', 'hierarchy']);
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
