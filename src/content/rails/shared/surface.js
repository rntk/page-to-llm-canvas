import { createRoot } from 'react-dom/client';
import { createLoadToken } from './recordFetch.js';

const IN_PAGE_RAIL_WIDTHS = Object.freeze({ topics: 260, summaries: 340, chat: 380 });
const IN_PAGE_RAIL_RESERVE_GAP = 16;

/**
 * Owns rail DOM, React roots, and load generations for one coordinator.
 */
export function createRailSurfaceManager({
  document: contentDocument,
  rootFactory = createRoot,
  preferences,
} = {}) {
  let activeRailController = null;
  const loadingTokenHolder = { current: null };
  const unregisterThemedSurface =
    preferences.registerThemedSurface(() => activeRailController?.railEl) || (() => {});

  function beginLoad() {
    return createLoadToken(loadingTokenHolder);
  }

  function createSurface({ state, youtube = false, onTeardown } = {}) {
    // A controller should normally close through the coordinator first, but
    // keep this ownership boundary safe for direct/future callers as well.
    if (activeRailController) {
      const currentLoadToken = loadingTokenHolder.current;
      close();
      loadingTokenHolder.current = currentLoadToken;
    }
    const railEl = contentDocument.createElement('aside');
    railEl.id = 'pagetollm-in-page-rail';
    railEl.dataset.mode = state.mode;
    if (youtube) railEl.dataset.youtube = 'true';
    preferences.applyContentTheme(railEl);
    preferences.applyContentHighlightColor(railEl);
    const railRoot = rootFactory(railEl);
    let railClosed = false;
    let railSurfaceTracked = false;

    const setRailWidthForMode = () => {
      if (railClosed) return;
      const railWidth = IN_PAGE_RAIL_WIDTHS[state.mode] || IN_PAGE_RAIL_WIDTHS.topics;
      railEl.style.width = `${railWidth}px`;
      contentDocument.documentElement.style.setProperty(
        '--pagetollm-rail-reserve',
        `${railWidth + IN_PAGE_RAIL_RESERVE_GAP}px`,
      );
      contentDocument.documentElement.style.setProperty('--pagetollm-rail-width', `${railWidth}px`);
    };

    contentDocument.documentElement.appendChild(railEl);
    preferences.trackMountedSurface();
    railSurfaceTracked = true;
    activeRailController = {
      railEl,
      teardown() {
        railClosed = true;
        railRoot.unmount();
        railEl.remove();
        if (railSurfaceTracked) {
          railSurfaceTracked = false;
          preferences.untrackMountedSurface();
        }
        onTeardown?.();
        clearPageRailState();
      },
    };

    setRailWidthForMode();
    contentDocument.body.classList.add('pagetollm-rail-open');
    return { railEl, railRoot, setRailWidthForMode, isClosed: () => railClosed };
  }

  function clearPageRailState() {
    contentDocument.body.classList.remove('pagetollm-rail-open');
    contentDocument.documentElement.style.removeProperty('--pagetollm-rail-reserve');
    contentDocument.documentElement.style.removeProperty('--pagetollm-rail-width');
  }

  function close() {
    loadingTokenHolder.current = null;
    if (activeRailController) {
      try {
        activeRailController.teardown();
      } catch (_) {
        /* cleanup below still runs */
      }
      activeRailController = null;
    }
    contentDocument
      .querySelectorAll('#pagetollm-in-page-rail')
      .forEach((railEl) => railEl.remove());
    clearPageRailState();
  }

  function dispose() {
    unregisterThemedSurface();
  }

  function destroy() {
    close();
    dispose();
  }

  return { beginLoad, createSurface, close, dispose, destroy };
}
