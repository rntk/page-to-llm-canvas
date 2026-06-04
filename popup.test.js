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
    expect(
      popup.providerConfigurationMessage({ providers: [{ id: 'p1' }], activeId: 'p1' }),
    ).toBe('');
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
});
