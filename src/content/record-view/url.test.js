import { describe, expect, it, vi } from 'vitest';
import { buildRecordViewIframeSrc } from './url.js';

describe('record-view URL', () => {
  it('builds iframe URLs for canvas and hierarchy views', () => {
    const getUrl = vi.fn((path) => `chrome-extension://test/${path}`);

    expect(buildRecordViewIframeSrc(getUrl, 'record key')).toBe(
      'chrome-extension://test/modal.html?key=record%20key',
    );
    expect(buildRecordViewIframeSrc(getUrl, 'record key', 'hierarchy')).toBe(
      'chrome-extension://test/modal.html?key=record%20key&view=hierarchy',
    );
    expect(buildRecordViewIframeSrc(getUrl, 'record key', 'canvas')).toBe(
      'chrome-extension://test/modal.html?key=record%20key',
    );
  });
});
