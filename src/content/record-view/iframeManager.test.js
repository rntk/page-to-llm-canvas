// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.stubGlobal('chrome', {
  runtime: {
    getURL: vi.fn((p) => 'about:blank#' + p),
  },
});

const {
  openCanvasIframe,
  openHierarchyIframe,
  removeCanvasIframe,
  getCanvasIframe,
  setRailCloser,
} = await import('./iframeManager.js');

describe('record-view iframe manager', () => {
  beforeEach(() => {
    removeCanvasIframe();
    setRailCloser(() => {});
  });

  afterEach(() => {
    removeCanvasIframe();
  });

  it('opens a canvas iframe, tracks it, and encodes the key in the src', () => {
    openCanvasIframe('my-key');
    const iframe = document.getElementById('pagetollm-canvas-iframe');
    expect(iframe).not.toBeNull();
    expect(iframe.parentNode).toBe(document.documentElement);
    expect(getCanvasIframe()).toBe(iframe);
    expect(iframe.src).toContain('my-key');
    expect(iframe.src).not.toContain('view=hierarchy');
  });

  it('opens a hierarchy iframe with the view param', () => {
    openHierarchyIframe('h key');
    const iframe = document.getElementById('pagetollm-canvas-iframe');
    expect(iframe.src).toContain('h%20key');
    expect(iframe.src).toContain('view=hierarchy');
  });

  it('replaces an existing iframe rather than stacking a second one', () => {
    openCanvasIframe('first');
    openCanvasIframe('second');
    expect(document.querySelectorAll('#pagetollm-canvas-iframe')).toHaveLength(1);
    expect(getCanvasIframe().src).toContain('second');
  });

  it('removes the iframe and clears the reference', () => {
    openCanvasIframe('gone');
    removeCanvasIframe();
    expect(document.getElementById('pagetollm-canvas-iframe')).toBeNull();
    expect(getCanvasIframe()).toBeNull();
  });

  it('invokes the injected rail closer on open (mutual exclusion)', () => {
    const closeRail = vi.fn();
    setRailCloser(closeRail);
    openCanvasIframe('excl');
    expect(closeRail).toHaveBeenCalledTimes(1);
  });
});
