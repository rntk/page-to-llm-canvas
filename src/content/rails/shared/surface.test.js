// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  createRoot,
  applyContentTheme,
  applyContentHighlightColor,
  trackMountedSurface,
  untrackMountedSurface,
  registerThemedSurface,
} = vi.hoisted(() => ({
  createRoot: vi.fn(() => ({ unmount: vi.fn() })),
  applyContentTheme: vi.fn(),
  applyContentHighlightColor: vi.fn(),
  trackMountedSurface: vi.fn(),
  untrackMountedSurface: vi.fn(),
  registerThemedSurface: vi.fn(),
}));

vi.mock('react-dom/client', () => ({ createRoot }));
vi.mock('../../shared/surfacePreferences.js', () => ({
  applyContentTheme,
  applyContentHighlightColor,
  trackMountedSurface,
  untrackMountedSurface,
  registerThemedSurface,
}));

import { closeInPageRail, createRailSurface, railLoadingTokenHolder } from './surface.js';

describe('in-page rail surface', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    document.documentElement.style.removeProperty('--pagetollm-rail-reserve');
    document.documentElement.style.removeProperty('--pagetollm-rail-width');
    railLoadingTokenHolder.current = 'active-load';
    vi.clearAllMocks();
  });

  afterEach(() => {
    closeInPageRail();
    document.body.innerHTML = '';
    document.documentElement.style.removeProperty('--pagetollm-rail-reserve');
    document.documentElement.style.removeProperty('--pagetollm-rail-width');
  });

  it('creates a themed topic rail with the expected attributes and bookkeeping', () => {
    const state = { mode: 'topics' };

    const surface = createRailSurface({ state });

    expect(surface.railEl).toBe(document.getElementById('pagetollm-in-page-rail'));
    expect(surface.railEl.tagName).toBe('ASIDE');
    expect(surface.railEl.dataset.mode).toBe('topics');
    expect(surface.railEl.hasAttribute('data-youtube')).toBe(false);
    expect(applyContentTheme).toHaveBeenCalledWith(surface.railEl);
    expect(applyContentHighlightColor).toHaveBeenCalledWith(surface.railEl);
    expect(createRoot).toHaveBeenCalledWith(surface.railEl);
    expect(trackMountedSurface).toHaveBeenCalledOnce();
    expect(document.body.classList.contains('pagetollm-rail-open')).toBe(true);
  });

  it('tags YouTube rails and reserves the mode-specific width', () => {
    const surface = createRailSurface({ state: { mode: 'summaries' }, youtube: true });

    expect(surface.railEl.dataset).toMatchObject({ mode: 'summaries', youtube: 'true' });
    expect(surface.railEl.style.width).toBe('340px');
    expect(document.documentElement.style.getPropertyValue('--pagetollm-rail-reserve')).toBe(
      '356px',
    );
    expect(document.documentElement.style.getPropertyValue('--pagetollm-rail-width')).toBe('340px');
  });

  it('uses the topics width for unknown modes and updates width when state changes', () => {
    const state = { mode: 'unknown' };
    const surface = createRailSurface({ state });

    expect(surface.railEl.style.width).toBe('260px');
    expect(document.documentElement.style.getPropertyValue('--pagetollm-rail-reserve')).toBe(
      '276px',
    );

    state.mode = 'chat';
    surface.setRailWidthForMode();

    expect(surface.railEl.style.width).toBe('380px');
    expect(document.documentElement.style.getPropertyValue('--pagetollm-rail-reserve')).toBe(
      '396px',
    );
  });

  it('tears down the React root, DOM, tracking, classes, styles, and callback', () => {
    const onTeardown = vi.fn();
    const root = { unmount: vi.fn() };
    createRoot.mockReturnValueOnce(root);
    const surface = createRailSurface({ state: { mode: 'chat' }, onTeardown });

    closeInPageRail();

    expect(root.unmount).toHaveBeenCalledOnce();
    expect(surface.railEl.isConnected).toBe(false);
    expect(untrackMountedSurface).toHaveBeenCalledOnce();
    expect(onTeardown).toHaveBeenCalledOnce();
    expect(document.body.classList.contains('pagetollm-rail-open')).toBe(false);
    expect(document.documentElement.style.getPropertyValue('--pagetollm-rail-width')).toBe('');
    expect(document.documentElement.style.getPropertyValue('--pagetollm-rail-reserve')).toBe('');
    expect(surface.isClosed()).toBe(true);

    surface.setRailWidthForMode();
    expect(document.documentElement.style.getPropertyValue('--pagetollm-rail-width')).toBe('');
  });

  it('invalidates loading work and removes duplicate rail hosts when closing', () => {
    const surface = createRailSurface({ state: { mode: 'topics' } });
    const duplicate = document.createElement('aside');
    duplicate.id = 'pagetollm-in-page-rail';
    document.documentElement.appendChild(duplicate);

    closeInPageRail();

    expect(railLoadingTokenHolder.current).toBeNull();
    expect(surface.railEl.isConnected).toBe(false);
    expect(duplicate.isConnected).toBe(false);
  });

  it('still clears global state when root unmount throws', () => {
    const root = {
      unmount: vi.fn(() => {
        throw new Error('unmount failed');
      }),
    };
    createRoot.mockReturnValueOnce(root);
    const onTeardown = vi.fn();
    createRailSurface({ state: { mode: 'topics' }, onTeardown });

    expect(() => closeInPageRail()).not.toThrow();
    expect(onTeardown).not.toHaveBeenCalled();
    expect(document.body.classList.contains('pagetollm-rail-open')).toBe(false);
    expect(document.documentElement.style.getPropertyValue('--pagetollm-rail-width')).toBe('');
  });
});
