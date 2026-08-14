// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.stubGlobal('chrome', {
  runtime: {
    getURL: vi.fn((p) => 'about:blank#' + p),
  },
});

const { createRecordFrameManager } = await import('./iframeManager.js');
let manager;

describe('record-view iframe manager', () => {
  beforeEach(() => {
    manager = createRecordFrameManager({
      document,
      getRuntimeUrl: (path) => chrome.runtime.getURL(path),
    });
    manager.close();
  });

  afterEach(() => {
    manager.close();
  });

  it('opens a canvas iframe, tracks it, and encodes the key in the src', () => {
    manager.open('my-key');
    const iframe = document.getElementById('pagetollm-canvas-iframe');
    expect(iframe).not.toBeNull();
    expect(iframe.parentNode).toBe(document.documentElement);
    expect(manager.getActiveFrame()).toBe(iframe);
    expect(iframe.src).toContain('my-key');
    expect(iframe.src).not.toContain('view=hierarchy');
  });

  it('opens a hierarchy iframe with the view param', () => {
    manager.open('h key', 'hierarchy');
    const iframe = document.getElementById('pagetollm-canvas-iframe');
    expect(iframe.src).toContain('h%20key');
    expect(iframe.src).toContain('view=hierarchy');
  });

  it('replaces an existing iframe rather than stacking a second one', () => {
    manager.open('first');
    manager.open('second');
    expect(document.querySelectorAll('#pagetollm-canvas-iframe')).toHaveLength(1);
    expect(manager.getActiveFrame().src).toContain('second');
  });

  it('removes the iframe and clears the reference', () => {
    manager.open('gone');
    manager.close();
    expect(document.getElementById('pagetollm-canvas-iframe')).toBeNull();
    expect(manager.getActiveFrame()).toBeNull();
  });

  it('does not share iframe ownership between manager instances', () => {
    const other = createRecordFrameManager({ document, getRuntimeUrl: chrome.runtime.getURL });
    manager.open('first');
    other.open('second');
    expect(manager.getActiveFrame().src).toContain('first');
    expect(other.getActiveFrame().src).toContain('second');
    manager.close();
    other.close();
  });
});
