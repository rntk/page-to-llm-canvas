// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  DEFAULT_HIGHLIGHT_COLOR,
  HIGHLIGHT_COLOR_KEY,
  applyHighlightColorToElement,
  getStoredHighlightColor,
  highlightColorWithAlpha,
  normalizeHighlightColor,
  setStoredHighlightColor,
} from './highlightSettings.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('highlight settings', () => {
  it('normalizes valid hex colors and falls back for invalid values', () => {
    expect(normalizeHighlightColor('#ABC')).toBe('#aabbcc');
    expect(normalizeHighlightColor(' #123456 ')).toBe('#123456');
    expect(normalizeHighlightColor('not-a-color')).toBe(DEFAULT_HIGHLIGHT_COLOR);
    expect(normalizeHighlightColor(null)).toBe(DEFAULT_HIGHLIGHT_COLOR);
  });

  it('builds alpha colors with clamped alpha values', () => {
    expect(highlightColorWithAlpha('#336699', 0.5)).toBe('rgb(51 102 153 / 0.5)');
    expect(highlightColorWithAlpha('#336699', -1)).toBe('rgb(51 102 153 / 0)');
    expect(highlightColorWithAlpha('#336699', 2)).toBe('rgb(51 102 153 / 1)');
    expect(highlightColorWithAlpha('#336699', Number.NaN)).toBe('rgb(51 102 153 / 1)');
  });

  it('applies highlight CSS custom properties to an element', () => {
    const el = document.createElement('div');
    applyHighlightColorToElement(el, '#abc', {
      backgroundAlpha: 0.1,
      hoverBackgroundAlpha: 0.2,
      activeBackgroundAlpha: 0.3,
    });

    expect(el.style.getPropertyValue('--pagetollm-highlight-base-color')).toBe('#aabbcc');
    expect(el.style.getPropertyValue('--pagetollm-highlight-color')).toBe('rgb(170 187 204 / 0.1)');
    expect(el.style.getPropertyValue('--pagetollm-highlight-hover-color')).toBe(
      'rgb(170 187 204 / 0.2)',
    );
    expect(el.style.getPropertyValue('--pagetollm-highlight-active-color')).toBe(
      'rgb(170 187 204 / 0.3)',
    );
  });

  it('ignores elements without a style API', () => {
    expect(() => applyHighlightColorToElement(null, '#abc')).not.toThrow();
    expect(() => applyHighlightColorToElement({}, '#abc')).not.toThrow();
  });

  it('reads stored highlight color with normalization and fallback paths', async () => {
    vi.stubGlobal('chrome', {
      runtime: {},
      storage: {
        local: {
          get: vi.fn((key, cb) => cb({ [key]: '#abc' })),
        },
      },
    });
    await expect(getStoredHighlightColor()).resolves.toBe('#aabbcc');

    chrome.runtime.lastError = { message: 'read failed' };
    await expect(getStoredHighlightColor()).resolves.toBe(DEFAULT_HIGHLIGHT_COLOR);

    chrome.storage.local.get = vi.fn(() => {
      throw new Error('missing storage');
    });
    await expect(getStoredHighlightColor()).resolves.toBe(DEFAULT_HIGHLIGHT_COLOR);
  });

  it('writes stored highlight color and rejects storage failures', async () => {
    vi.stubGlobal('chrome', {
      runtime: {},
      storage: {
        local: {
          set: vi.fn((items, cb) => cb()),
        },
      },
    });

    await expect(setStoredHighlightColor('#ABC')).resolves.toBe('#aabbcc');
    expect(chrome.storage.local.set).toHaveBeenCalledWith(
      { [HIGHLIGHT_COLOR_KEY]: '#aabbcc' },
      expect.any(Function),
    );

    chrome.runtime.lastError = { message: 'write failed' };
    await expect(setStoredHighlightColor('#123456')).rejects.toThrow('write failed');

    chrome.runtime.lastError = null;
    chrome.storage.local.set = vi.fn(() => {
      throw 'boom';
    });
    await expect(setStoredHighlightColor('#123456')).rejects.toThrow('boom');
  });
});
