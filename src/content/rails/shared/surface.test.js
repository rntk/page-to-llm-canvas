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

import { createRailSurfaceManager } from './surface.js';

let manager;
const preferences = {
  applyContentTheme,
  applyContentHighlightColor,
  trackMountedSurface,
  untrackMountedSurface,
  registerThemedSurface,
};

describe('in-page rail surface', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    document.documentElement.style.removeProperty('--pagetollm-rail-reserve');
    document.documentElement.style.removeProperty('--pagetollm-rail-width');
    vi.clearAllMocks();
    registerThemedSurface.mockReturnValue(vi.fn());
    manager = createRailSurfaceManager({ document, rootFactory: createRoot, preferences });
  });

  afterEach(() => {
    manager.close();
    document.body.innerHTML = '';
    document.documentElement.style.removeProperty('--pagetollm-rail-reserve');
    document.documentElement.style.removeProperty('--pagetollm-rail-width');
  });

  it('creates a themed topic rail with the expected attributes and bookkeeping', () => {
    const state = { mode: 'topics' };

    const surface = manager.createSurface({ state });

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

  it('injects the rail stylesheet on mount and removes it on close', () => {
    expect(document.getElementById('pagetollm-rail-styles')).toBeNull();

    manager.createSurface({ state: { mode: 'topics' } });
    const styleEl = document.getElementById('pagetollm-rail-styles');

    expect(styleEl).not.toBeNull();
    expect(styleEl.tagName).toBe('STYLE');

    // Re-mounting reuses the sheet rather than stacking duplicates.
    manager.createSurface({ state: { mode: 'chat' } });
    expect(document.querySelectorAll('#pagetollm-rail-styles')).toHaveLength(1);

    manager.close();
    expect(document.getElementById('pagetollm-rail-styles')).toBeNull();
  });

  it('does not mount a rail when the document has no body', () => {
    const body = document.body;
    body.remove();
    try {
      expect(manager.createSurface({ state: { mode: 'topics' } })).toBeNull();
      expect(document.getElementById('pagetollm-in-page-rail')).toBeNull();
      expect(createRoot).not.toHaveBeenCalled();
      expect(trackMountedSurface).not.toHaveBeenCalled();
    } finally {
      document.documentElement.appendChild(body);
    }
  });

  it('tags YouTube rails and reserves the mode-specific width', () => {
    const surface = manager.createSurface({ state: { mode: 'summaries' }, youtube: true });

    expect(surface.railEl.dataset).toMatchObject({ mode: 'summaries', youtube: 'true' });
    expect(surface.railEl.style.width).toBe('340px');
    expect(document.documentElement.style.getPropertyValue('--pagetollm-rail-reserve')).toBe(
      '356px',
    );
    expect(document.documentElement.style.getPropertyValue('--pagetollm-rail-width')).toBe('340px');
  });

  it('tears down an existing rail before mounting a replacement', () => {
    const firstRoot = { unmount: vi.fn() };
    createRoot.mockReturnValueOnce(firstRoot);
    const first = manager.createSurface({ state: { mode: 'topics' } });

    const second = manager.createSurface({ state: { mode: 'chat' } });

    expect(firstRoot.unmount).toHaveBeenCalledOnce();
    expect(first.isClosed()).toBe(true);
    expect(first.railEl.isConnected).toBe(false);
    expect(second.railEl.isConnected).toBe(true);
    expect(document.querySelectorAll('#pagetollm-in-page-rail')).toHaveLength(1);
  });

  it('uses the topics width for unknown modes and updates width when state changes', () => {
    const state = { mode: 'unknown' };
    const surface = manager.createSurface({ state });

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
    const surface = manager.createSurface({ state: { mode: 'chat' }, onTeardown });

    manager.close();

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

  it('invalidates loading work without removing a rail owned by another manager', () => {
    const surface = manager.createSurface({ state: { mode: 'topics' } });
    const otherRoot = { unmount: vi.fn() };
    createRoot.mockReturnValueOnce(otherRoot);
    const other = createRailSurfaceManager({ document, rootFactory: createRoot, preferences });
    const otherSurface = other.createSurface({ state: { mode: 'chat' } });

    const guard = manager.beginLoad();
    manager.close();

    expect(guard.isStale()).toBe(true);
    expect(surface.railEl.isConnected).toBe(false);
    expect(otherSurface.railEl.isConnected).toBe(true);
    expect(otherRoot.unmount).not.toHaveBeenCalled();
    expect(otherSurface.isClosed()).toBe(false);
    expect(document.body.classList.contains('pagetollm-rail-open')).toBe(true);
    expect(document.documentElement.style.getPropertyValue('--pagetollm-rail-width')).toBe('380px');

    other.close();
  });

  it('removes an abandoned rail host before mounting', () => {
    const stale = document.createElement('aside');
    stale.id = 'pagetollm-in-page-rail';
    document.documentElement.appendChild(stale);

    const surface = manager.createSurface({ state: { mode: 'topics' } });

    expect(stale.isConnected).toBe(false);
    expect(surface.railEl.isConnected).toBe(true);
  });

  it('still clears global state when root unmount throws', () => {
    const root = {
      unmount: vi.fn(() => {
        throw new Error('unmount failed');
      }),
    };
    createRoot.mockReturnValueOnce(root);
    const onTeardown = vi.fn();
    manager.createSurface({ state: { mode: 'topics' }, onTeardown });

    expect(() => manager.close()).not.toThrow();
    expect(onTeardown).toHaveBeenCalledOnce();
    expect(untrackMountedSurface).toHaveBeenCalledOnce();
    expect(document.getElementById('pagetollm-in-page-rail')).toBeNull();
    expect(document.body.classList.contains('pagetollm-rail-open')).toBe(false);
    expect(document.documentElement.style.getPropertyValue('--pagetollm-rail-width')).toBe('');
  });

  describe('rail reserve fit class (overflow-driven)', () => {
    const mockMetrics = (scrollWidth, clientWidth) => {
      Object.defineProperty(document.documentElement, 'scrollWidth', {
        configurable: true,
        get: () => scrollWidth,
      });
      Object.defineProperty(document.documentElement, 'clientWidth', {
        configurable: true,
        get: () => clientWidth,
      });
    };

    const mockReserveAwareMetrics = (baseWidth, clientWidth) => {
      Object.defineProperty(document.documentElement, 'scrollWidth', {
        configurable: true,
        get: () => {
          const reserve =
            document.documentElement.style.getPropertyValue('--pagetollm-rail-reserve') || '';
          const parsed = parseInt(reserve, 10);
          const extra = Number.isFinite(parsed) ? parsed : 0;
          return baseWidth + extra;
        },
      });
      Object.defineProperty(document.documentElement, 'clientWidth', {
        configurable: true,
        get: () => clientWidth,
      });
    };

    const clearMetrics = () => {
      // Deleting the own property re-exposes the prototype getter (0 in happy-dom).
      delete document.documentElement.scrollWidth;
      delete document.documentElement.clientWidth;
    };

    afterEach(() => {
      clearMetrics();
      document.body.classList.remove('pagetollm-rail-fit', 'pagetollm-rail-open');
    });

    it('adds pagetollm-rail-fit when the reserve padding pushes a content-box body into overflow', () => {
      // No overflow before the reserve, but any reserve widens a fixed-width body past the viewport.
      mockReserveAwareMetrics(900, 1000);

      const surface = manager.createSurface({ state: { mode: 'topics' } });

      expect(document.body.classList.contains('pagetollm-rail-open')).toBe(true);
      expect(document.body.classList.contains('pagetollm-rail-fit')).toBe(true);
      expect(document.documentElement.style.getPropertyValue('--pagetollm-rail-reserve')).toBe('276px');

      // Falsy path: clearing the injected overflow restores the normal box model.
      mockMetrics(1000, 1000);
      surface.setRailWidthForMode();
      expect(document.body.classList.contains('pagetollm-rail-fit')).toBe(false);

      clearMetrics();
      manager.close();
    });

    it('never adds fit when the page already overflowed before the reserve', () => {
      // Pre-existing overflow must not be mistaken for overflow we caused.
      mockMetrics(1200, 1000);

      const surface = manager.createSurface({ state: { mode: 'topics' } });

      expect(document.body.classList.contains('pagetollm-rail-open')).toBe(true);
      expect(document.body.classList.contains('pagetollm-rail-fit')).toBe(false);

      // Even when the mode (and therefore the reserve) changes, the guard stays latched.
      surface.setRailWidthForMode();
      expect(document.body.classList.contains('pagetollm-rail-fit')).toBe(false);

      // Create a second surface via the same manager to prove the per-surface capture.
      // First close the overflowed surface cleanly before opening with a new state object
      // so width-change logic is exercised through the state reference.
      manager.close();
      clearMetrics();
      mockMetrics(1200, 1000);
      const secondState = { mode: 'chat' };
      const second = manager.createSurface({ state: secondState });
      secondState.mode = 'summaries';
      second.setRailWidthForMode();
      expect(document.body.classList.contains('pagetollm-rail-fit')).toBe(false);

      clearMetrics();
      manager.close();
    });

    it('re-evaluates fit whenever the reserve width changes across modes', () => {
      // Reserve-aware overflow: topics (276px) keeps 724+276=1000 within 1000px, but chat (396px) pushes it over.
      mockReserveAwareMetrics(724, 1000);
      const state = { mode: 'topics' };

      const surface = manager.createSurface({ state });

      expect(document.body.classList.contains('pagetollm-rail-fit')).toBe(false);
      expect(document.documentElement.style.getPropertyValue('--pagetollm-rail-reserve')).toBe('276px');

      state.mode = 'chat';
      surface.setRailWidthForMode();
      expect(document.documentElement.style.getPropertyValue('--pagetollm-rail-reserve')).toBe('396px');
      expect(document.body.classList.contains('pagetollm-rail-fit')).toBe(true);

      state.mode = 'summaries';
      surface.setRailWidthForMode();
      expect(document.documentElement.style.getPropertyValue('--pagetollm-rail-reserve')).toBe('356px');
      expect(document.body.classList.contains('pagetollm-rail-fit')).toBe(true);

      state.mode = 'topics';
      surface.setRailWidthForMode();
      expect(document.documentElement.style.getPropertyValue('--pagetollm-rail-reserve')).toBe('276px');
      expect(document.body.classList.contains('pagetollm-rail-fit')).toBe(false);

      // Explicit overflow without reserve-awareness also toggles on every width change.
      mockMetrics(1100, 1000);
      state.mode = 'chat';
      surface.setRailWidthForMode();
      expect(document.body.classList.contains('pagetollm-rail-fit')).toBe(true);

      mockMetrics(1000, 1000);
      state.mode = 'summaries';
      surface.setRailWidthForMode();
      expect(document.body.classList.contains('pagetollm-rail-fit')).toBe(false);

      clearMetrics();
      manager.close();
    });

    it('clears fit on close and does not leak it to the next surface', () => {
      mockReserveAwareMetrics(900, 1000);
      const first = manager.createSurface({ state: { mode: 'chat' } });
      expect(document.body.classList.contains('pagetollm-rail-fit')).toBe(true);

      manager.close();
      expect(document.body.classList.contains('pagetollm-rail-open')).toBe(false);
      expect(document.body.classList.contains('pagetollm-rail-fit')).toBe(false);
      expect(document.documentElement.style.getPropertyValue('--pagetollm-rail-reserve')).toBe('');

      // Next surface starts fresh: even with the same overflow, pre-overflow is re-captured.
      mockMetrics(1000, 1000);
      const second = manager.createSurface({ state: { mode: 'topics' } });
      expect(document.body.classList.contains('pagetollm-rail-fit')).toBe(false);
      expect(first.isClosed()).toBe(true);
      expect(second.isClosed()).toBe(false);

      clearMetrics();
      manager.close();
    });

    it('does not re-add fit after the rail is closed (railClosed guard)', () => {
      mockReserveAwareMetrics(900, 1000);
      const surface = manager.createSurface({ state: { mode: 'topics' } });
      expect(document.body.classList.contains('pagetollm-rail-fit')).toBe(true);

      manager.close();
      expect(document.body.classList.contains('pagetollm-rail-fit')).toBe(false);

      // Mutating mocked overflow and calling the stale handle must not resurrect the class.
      mockMetrics(1200, 1000);
      surface.setRailWidthForMode();
      expect(document.body.classList.contains('pagetollm-rail-fit')).toBe(false);
      expect(document.body.classList.contains('pagetollm-rail-open')).toBe(false);

      clearMetrics();
    });
  });
});
