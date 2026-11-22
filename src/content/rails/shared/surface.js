import { createRoot } from 'react-dom/client';
import { normalizeRailMode, normalizeRailSide } from './railState.js';
import { RAIL_MODE } from '../../../shared/runtime/contracts.js';
import { createLogger } from '../../../shared/runtime/log.js';
// ?inline supplies CSS text for a style node managed over the rail's lifetime.
import contentRailCss from '../../../extension/styles/content-rail.css?inline';
import chatCss from '../../../extension/styles/chat.css?inline';

const log = createLogger();

export const RAIL_STYLE_ELEMENT_ID = 'pagetollm-rail-styles';

// Keep rail rules after chat defaults so their overrides win.
const RAIL_STYLES = `${chatCss}\n${contentRailCss}`;

/**
 * Add the rail stylesheet to a document, once.
 *
 * @param {Document} contentDocument Document hosting the rail.
 */
export function ensureRailStyles(contentDocument) {
  if (!contentDocument) return;
  if (contentDocument.getElementById(RAIL_STYLE_ELEMENT_ID)) return;
  const parent = contentDocument.head ?? contentDocument.documentElement;
  if (!parent) return;
  const style = contentDocument.createElement('style');
  style.id = RAIL_STYLE_ELEMENT_ID;
  // Firefox retains the extension principal for textContent, unlike innerText.
  // CSS subresources still follow the page CSP; avoid url()/@font-face/@import.
  style.textContent = RAIL_STYLES;
  parent.appendChild(style);
}

/**
 * Remove the rail stylesheet once no rail is left to style.
 *
 * @param {Document} contentDocument Document hosting the rail.
 */
export function removeRailStyles(contentDocument) {
  contentDocument?.getElementById(RAIL_STYLE_ELEMENT_ID)?.remove();
}

const IN_PAGE_RAIL_WIDTHS = Object.freeze({
  [RAIL_MODE.TOPICS]: 260,
  [RAIL_MODE.SUMMARIES]: 340,
  [RAIL_MODE.CHAT]: 380,
});
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
  // The chosen side outlives a single rail, so the next one opens where the last was.
  let preferredSide = 'right';
  let currentLoadToken = null;
  const unregisterThemedSurface =
    preferences.registerThemedSurface(() => activeRailController?.railEl) || (() => {});

  function beginLoad() {
    const token = Symbol('rail-loading');
    currentLoadToken = token;
    return { isStale: () => currentLoadToken !== token };
  }

  function createSurface({ initialMode, youtube = false, onTeardown } = {}) {
    // XML/SVG documents lack a body; do not create an orphan host.
    if (!contentDocument.body) return null;

    if (activeRailController) teardownActiveRail();
    // Remove hosts abandoned by an earlier content-script lifetime.
    removeStaleRailElements(contentDocument);
    ensureRailStyles(contentDocument);
    const railEl = contentDocument.createElement('aside');
    railEl.id = 'pagetollm-in-page-rail';
    let mode = normalizeRailMode(initialMode);
    let side = preferredSide;
    railEl.dataset.mode = mode;
    railEl.dataset.side = side;
    if (youtube) railEl.dataset.youtube = 'true';
    preferences.applyContentTheme(railEl);
    preferences.applyContentHighlightColor(railEl);
    // A render-time throw would otherwise leave a blank rail with no close button.
    const railRoot = rootFactory(railEl, {
      onUncaughtError: (error) => {
        if (railClosed) return;
        log.error('rail render error:', error);
        close();
      },
    });
    let railClosed = false;
    let railSurfaceTracked = false;
    // Distinguish existing overflow from overflow caused by rail padding.
    let overflowedBeforeReserve = false;

    // Explicit content-box widths can overflow when padded; adjust only then.
    const syncRailReserveFit = () => {
      const body = contentDocument.body;
      if (railClosed || overflowedBeforeReserve) return;
      if (!body?.classList.contains('pagetollm-rail-open')) return;
      body.classList.remove('pagetollm-rail-fit');
      const docEl = contentDocument.documentElement;
      if (docEl.scrollWidth > docEl.clientWidth) body.classList.add('pagetollm-rail-fit');
    };

    const syncRailWidth = () => {
      const railWidth = IN_PAGE_RAIL_WIDTHS[mode];
      railEl.style.width = `${railWidth}px`;
      contentDocument.documentElement.style.setProperty(
        '--pagetollm-rail-reserve',
        `${railWidth + IN_PAGE_RAIL_RESERVE_GAP}px`,
      );
      contentDocument.documentElement.style.setProperty('--pagetollm-rail-width', `${railWidth}px`);
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
        if (cleanupError) throw cleanupError;
      },
    };

    overflowedBeforeReserve =
      contentDocument.documentElement.scrollWidth > contentDocument.documentElement.clientWidth;
    syncRailWidth();
    contentDocument.body.classList.add('pagetollm-rail-open');
    contentDocument.body.classList.toggle('pagetollm-rail-left', side === 'left');
    syncRailReserveFit();

    return {
      railEl,
      railRoot,
      get mode() {
        return mode;
      },
      get side() {
        return side;
      },
      setMode(value) {
        const next = normalizeRailMode(value);
        if (railClosed || mode === next) return false;
        mode = next;
        railEl.dataset.mode = mode;
        syncRailWidth();
        syncRailReserveFit();
        return true;
      },
      setSide(value) {
        const next = normalizeRailSide(value);
        if (railClosed || side === next) return false;
        side = preferredSide = next;
        railEl.dataset.side = side;
        contentDocument.body?.classList.toggle('pagetollm-rail-left', side === 'left');
        // Moving the reserve can change whether the page overflows.
        syncRailReserveFit();
        return true;
      },
      isClosed: () => railClosed,
    };
  }

  function clearPageRailState() {
    const hasOwnedRail = Array.from(
      contentDocument.querySelectorAll('#pagetollm-in-page-rail'),
    ).some((railEl) => ownedRailElements.has(railEl));
    if (hasOwnedRail) return;
    removeRailStyles(contentDocument);
    contentDocument.body?.classList.remove(
      'pagetollm-rail-open',
      'pagetollm-rail-fit',
      'pagetollm-rail-left',
    );
    contentDocument.documentElement.style.removeProperty('--pagetollm-rail-reserve');
    contentDocument.documentElement.style.removeProperty('--pagetollm-rail-width');
  }

  function teardownActiveRail() {
    const controller = activeRailController;
    activeRailController = null;
    try {
      controller?.teardown();
    } catch (_) {
      /* cleanup below still runs */
    }
    clearPageRailState();
  }

  function close() {
    currentLoadToken = null;
    teardownActiveRail();
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
