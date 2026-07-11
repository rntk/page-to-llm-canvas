// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// contentPreferences reads storage at module load, so stub chrome before import.
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
  applyContentTheme,
  applyContentHighlightColor,
  trackMountedSurface,
  untrackMountedSurface,
  registerThemedSurface,
} = await import('./contentPreferences.js');

describe('contentPreferences', () => {
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
});
