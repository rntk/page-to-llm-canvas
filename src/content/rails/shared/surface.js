import { createRoot } from 'react-dom/client';
import { createLoadToken } from './recordFetch.js';
import { ensureRailStyles, removeRailStyles } from './railStyles.js';

const IN_PAGE_RAIL_WIDTHS = Object.freeze({ topics: 260, summaries: 340, chat: 380 });
const IN_PAGE_RAIL_RESERVE_GAP = 16;
const ownedRailElements = new WeakSet();

function removeStaleRailElements(contentDocument) {
  contentDocument.querySelectorAll('#pagetollm-in-page-rail').forEach((railEl) => {
    if (!ownedRailElements.has(railEl)) railEl.remove();
  });
}

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
    // XML/SVG documents do not expose a body. Bail out before creating or
    // appending anything so an unsuccessful mount cannot leak a rail host.
    if (!contentDocument.body) return null;

    // A controller should normally close through the coordinator first, but
    // keep this ownership boundary safe for direct/future callers as well.
    if (activeRailController) {
      const currentLoadToken = loadingTokenHolder.current;
      close();
      loadingTokenHolder.current = currentLoadToken;
    }
    // A previous content-script lifetime can leave its host behind. Remove only
    // hosts that are not owned by a live manager in this module instance.
    removeStaleRailElements(contentDocument);
    ensureRailStyles(contentDocument);
    const railEl = contentDocument.createElement('aside');
    railEl.id = 'pagetollm-in-page-rail';
    railEl.dataset.mode = state.mode;
    if (youtube) railEl.dataset.youtube = 'true';
    preferences.applyContentTheme(railEl);
    preferences.applyContentHighlightColor(railEl);
    const railRoot = rootFactory(railEl);
    let railClosed = false;
    let railSurfaceTracked = false;
    // Captured before the reserve padding is applied, so overflow the page had
    // on its own is never mistaken for overflow we caused.
    let overflowedBeforeReserve = false;

    // A body with an explicit width under content-box grows by the reserve
    // padding instead of yielding space to the rail. Flip its box model only
    // while the padding is what pushes the page into horizontal overflow, and
    // re-evaluate whenever the reserve width changes.
    const syncRailReserveFit = () => {
      const body = contentDocument.body;
      if (railClosed || overflowedBeforeReserve) return;
      if (!body?.classList.contains('pagetollm-rail-open')) return;
      body.classList.remove('pagetollm-rail-fit');
      const docEl = contentDocument.documentElement;
      if (docEl.scrollWidth > docEl.clientWidth) body.classList.add('pagetollm-rail-fit');
    };

    const setRailWidthForMode = () => {
      if (railClosed) return;
      const railWidth = IN_PAGE_RAIL_WIDTHS[state.mode] || IN_PAGE_RAIL_WIDTHS.topics;
      railEl.style.width = `${railWidth}px`;
      contentDocument.documentElement.style.setProperty(
        '--pagetollm-rail-reserve',
        `${railWidth + IN_PAGE_RAIL_RESERVE_GAP}px`,
      );
      contentDocument.documentElement.style.setProperty('--pagetollm-rail-width', `${railWidth}px`);
      syncRailReserveFit();
    };

    contentDocument.documentElement.appendChild(railEl);
    ownedRailElements.add(railEl);
    preferences.trackMountedSurface(contentDocument);
    railSurfaceTracked = true;
    activeRailController = {
      railEl,
      teardown() {
        railClosed = true;
        let cleanupError = null;
        try {
          railRoot.unmount();
        } catch (err) {
          cleanupError = err;
        }
        ownedRailElements.delete(railEl);
        railEl.remove();
        if (railSurfaceTracked) {
          railSurfaceTracked = false;
          try {
            preferences.untrackMountedSurface();
          } catch (err) {
            cleanupError ||= err;
          }
        }
        try {
          onTeardown?.();
        } catch (err) {
          cleanupError ||= err;
        }
        clearPageRailState();
        if (cleanupError) throw cleanupError;
      },
    };

    overflowedBeforeReserve =
      contentDocument.documentElement.scrollWidth > contentDocument.documentElement.clientWidth;
    setRailWidthForMode();
    contentDocument.body.classList.add('pagetollm-rail-open');
    syncRailReserveFit();
    return { railEl, railRoot, setRailWidthForMode, isClosed: () => railClosed };
  }

  function clearPageRailState() {
    const hasOwnedRail = Array.from(
      contentDocument.querySelectorAll('#pagetollm-in-page-rail'),
    ).some((railEl) => ownedRailElements.has(railEl));
    if (hasOwnedRail) return;
    removeRailStyles(contentDocument);
    contentDocument.body?.classList.remove('pagetollm-rail-open', 'pagetollm-rail-fit');
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
