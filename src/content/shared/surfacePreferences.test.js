// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// surfacePreferences touches chrome.storage as soon as init()/a mount runs, so
// stub chrome before import. Importing alone must not read storage (see below).
let storageChangeListener = null;
let themeValue;
let highlightValue;

vi.stubGlobal('chrome', {
  runtime: { lastError: null },
  storage: {
    local: {
      get: vi.fn((key, cb) => {
        if (key === 'pagetollm-theme') cb({ 'pagetollm-theme': themeValue });
        else if (key === 'pagetollm-highlight-color')
          cb({ 'pagetollm-highlight-color': highlightValue });
        else cb({});
      }),
    },
    onChanged: {
      addListener: vi.fn((fn) => {
        storageChangeListener = fn;
      }),
      removeListener: vi.fn((fn) => {
        if (storageChangeListener === fn) storageChangeListener = null;
      }),
    },
  },
});

const {
  init,
  applyContentTheme,
  applyContentHighlightColor,
  trackMountedSurface,
  untrackMountedSurface,
  registerThemedSurface,
} = await import('./surfacePreferences.js');

// Asserted before any test can call init(): the module was imported above and
// must not have started any storage work on its own.
const readsAtImportTime = chrome.storage.local.get.mock.calls.length;

describe('surfacePreferences', () => {
  beforeEach(() => {
    themeValue = undefined;
    highlightValue = undefined;
    storageChangeListener = null;
    chrome.storage.onChanged.addListener.mockClear();
    chrome.storage.onChanged.removeListener.mockClear();
  });

  afterEach(() => {
    // Drain the refcount back to zero so listener state is clean between tests.
    untrackMountedSurface();
    untrackMountedSurface();
  });

  it('does not read storage at import time, only when init() runs', async () => {
    expect(readsAtImportTime).toBe(0);

    chrome.storage.local.get.mockClear();
    await init();
    expect(chrome.storage.local.get).toHaveBeenCalled();

    // init() is a one-shot; a second call must not re-read.
    chrome.storage.local.get.mockClear();
    await init();
    expect(chrome.storage.local.get).not.toHaveBeenCalled();
  });

  it('applies the cached (default system) theme by removing data-theme', () => {
    const el = document.createElement('div');
    el.setAttribute('data-theme', 'dark');
    applyContentTheme(el);
    expect(el.hasAttribute('data-theme')).toBe(false);
  });

  it('applies a highlight color as a CSS custom property', () => {
    const el = document.createElement('div');
    applyContentHighlightColor(el);
    expect(el.style.getPropertyValue('--pagetollm-highlight-color')).not.toBe('');
  });

  it('attaches the storage listener only while a surface is mounted (refcounted)', () => {
    expect(chrome.storage.onChanged.addListener).not.toHaveBeenCalled();

    trackMountedSurface();
    expect(chrome.storage.onChanged.addListener).toHaveBeenCalledTimes(1);

    // Second surface must not attach a duplicate listener.
    trackMountedSurface();
    expect(chrome.storage.onChanged.addListener).toHaveBeenCalledTimes(1);

    untrackMountedSurface();
    expect(chrome.storage.onChanged.removeListener).not.toHaveBeenCalled();

    untrackMountedSurface();
    expect(chrome.storage.onChanged.removeListener).toHaveBeenCalledTimes(1);
  });

  it('keeps an in-flight highlight-color read alive when only the theme changes', async () => {
    // Generations are per preference, so a theme-only change event must not
    // discard the pending read for the highlight color (which would leave it at
    // the default until the next mount).
    const deferredReads = [];
    const realGet = chrome.storage.local.get.getMockImplementation();
    chrome.storage.local.get.mockImplementation((key, cb) => {
      deferredReads.push(() => realGet(key, cb));
    });
    themeValue = 'light';
    highlightValue = '#00ff00';

    const el = document.createElement('div');
    const unregister = registerThemedSurface(() => el);
    try {
      trackMountedSurface(); // attaches the listener and starts both reads

      // The reads defer before touching storage, so let both get in flight
      // before invalidating one of them.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(deferredReads.length).toBe(2);

      storageChangeListener({ 'pagetollm-theme': { newValue: 'dark' } }, 'local');
      deferredReads.forEach((resolve) => resolve());
      await new Promise((resolve) => setTimeout(resolve, 0));

      // The newer change event wins for the theme; the untouched preference
      // still lands from its own read.
      expect(el.getAttribute('data-theme')).toBe('dark');
      expect(el.style.getPropertyValue('--pagetollm-highlight-base-color')).toBe('#00ff00');
    } finally {
      chrome.storage.local.get.mockImplementation(realGet);
      unregister();
      untrackMountedSurface();
    }
  });

  it('re-tags a registered surface when the theme changes via storage', () => {
    const el = document.createElement('div');
    const unregister = registerThemedSurface(() => el);
    trackMountedSurface();

    expect(storageChangeListener).not.toBeNull();
    storageChangeListener({ 'pagetollm-theme': { newValue: 'dark' } }, 'local');
    expect(el.getAttribute('data-theme')).toBe('dark');

    storageChangeListener({ 'pagetollm-theme': { newValue: 'light' } }, 'local');
    expect(el.getAttribute('data-theme')).toBe('light');

    // A non-preference change must not touch the surface.
    storageChangeListener({ 'pagetollm:rec:x': { newValue: 1 } }, 'local');
    expect(el.getAttribute('data-theme')).toBe('light');

    unregister();
    untrackMountedSurface();
  });

  it('clears the highlight vars from documentElement only when the last surface unmounts', () => {
    // The vars live on the host page's documentElement (that is where
    // ::highlight(pagetollm-sentence) resolves them), so they are the one piece
    // of our styling that outlives the surfaces unless teardown removes it.
    const docStyle = document.documentElement.style;
    const HIGHLIGHT_VARS = [
      '--pagetollm-highlight-base-color',
      '--pagetollm-highlight-color',
      '--pagetollm-highlight-hover-color',
      '--pagetollm-highlight-active-color',
    ];

    trackMountedSurface(document);
    HIGHLIGHT_VARS.forEach((prop) => expect(docStyle.getPropertyValue(prop)).not.toBe(''));

    // A second surface is still mounted, so dropping the first must not strip
    // the page's highlight palette out from under it.
    trackMountedSurface(document);
    untrackMountedSurface();
    HIGHLIGHT_VARS.forEach((prop) => expect(docStyle.getPropertyValue(prop)).not.toBe(''));

    untrackMountedSurface();
    HIGHLIGHT_VARS.forEach((prop) => expect(docStyle.getPropertyValue(prop)).toBe(''));
  });

  it('does not repaint documentElement when a storage read resolves after teardown', async () => {
    // Mount-then-close leaves a read in flight past the moment the vars are
    // cleared. Without a generation bump on teardown that read would re-apply
    // the palette to the host page permanently, since nothing clears it again.
    const deferredReads = [];
    const realGet = chrome.storage.local.get.getMockImplementation();
    chrome.storage.local.get.mockImplementation((key, cb) => {
      deferredReads.push(() => realGet(key, cb));
    });
    highlightValue = '#00ff00';

    try {
      trackMountedSurface(document); // attaches the listener and starts both reads
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(deferredReads.length).toBe(2);

      untrackMountedSurface(); // last surface: clears the vars
      deferredReads.forEach((resolve) => resolve());
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(
        document.documentElement.style.getPropertyValue('--pagetollm-highlight-base-color'),
      ).toBe('');
    } finally {
      chrome.storage.local.get.mockImplementation(realGet);
    }
  });

  it('repaints documentElement synchronously on remount, before any read resolves', async () => {
    // Teardown clears the vars, so a remount that waited for a fresh storage
    // read would flash the CSS default color at anyone with a custom one. The
    // cache is still warm, so the repaint must happen on the mount itself.
    const docStyle = document.documentElement.style;
    highlightValue = '#00ff00';
    trackMountedSurface(document);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(docStyle.getPropertyValue('--pagetollm-highlight-base-color')).toBe('#00ff00');

    untrackMountedSurface();
    expect(docStyle.getPropertyValue('--pagetollm-highlight-base-color')).toBe('');

    // Storage never answers, so only a synchronous repaint can satisfy this.
    const realGet = chrome.storage.local.get.getMockImplementation();
    chrome.storage.local.get.mockImplementation(() => {});
    try {
      trackMountedSurface(document);
      expect(docStyle.getPropertyValue('--pagetollm-highlight-base-color')).toBe('#00ff00');
    } finally {
      chrome.storage.local.get.mockImplementation(realGet);
      untrackMountedSurface();
    }
  });
});
