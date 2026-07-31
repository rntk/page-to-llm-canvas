import { createRoot } from 'react-dom/client';
import {
  applyContentTheme,
  applyContentHighlightColor,
  trackMountedSurface,
  untrackMountedSurface,
  registerThemedSurface,
} from '../../shared/surfacePreferences.js';

const IN_PAGE_RAIL_WIDTHS = Object.freeze({
  topics: 260,
  summaries: 340,
  chat: 380,
});
const IN_PAGE_RAIL_RESERVE_GAP = 16;

// The teardown handle for whichever rail (scroll-synced or YouTube) is currently
// mounted. Shared by both rail controllers via createRailSurface/closeInPageRail.
let activeRailController = null;

// One shared holder for the load-token staleness guard. Both rails and
// closeInPageRail read/write `current`, so a newer request (or a close)
// invalidates a still-loading one.
export const railLoadingTokenHolder = { current: null };

// Re-tag the mounted rail on theme/highlight changes. Registered once; the
// getter returns the live host element (or null when no rail is open).
registerThemedSurface(() => activeRailController && activeRailController.railEl);

/**
 * Create the shared in-page rail surface used by both the scroll-synced rail
 * and the YouTube rail: the `<aside>` host, its themed React root, the mount
 * bookkeeping, and the `activeRailController` teardown. The two rails differ
 * only in a couple of options captured here.
 *
 * @param {object} opts
 * @param {{ mode: string }} opts.state - Live rail state; `setRailWidthForMode` reads `state.mode`.
 * @param {boolean} [opts.youtube] - Tag the host with `data-youtube` (YouTube rail only).
 * @param {function(): void} [opts.onTeardown] - Extra teardown step (e.g. clearing CSS highlights).
 * @returns {{ railEl: HTMLElement, railRoot: object, setRailWidthForMode: function(): void, isClosed: function(): boolean }}
 */
export function createRailSurface({ state, youtube = false, onTeardown } = {}) {
  const railEl = document.createElement('aside');
  railEl.id = 'pagetollm-in-page-rail';
  railEl.dataset.mode = state.mode;
  if (youtube) railEl.dataset.youtube = 'true';
  applyContentTheme(railEl);
  applyContentHighlightColor(railEl);
  const railRoot = createRoot(railEl);
  let railClosed = false;
  let railSurfaceTracked = false;

  const setRailWidthForMode = () => {
    if (railClosed) return;
    const railWidth = IN_PAGE_RAIL_WIDTHS[state.mode] || IN_PAGE_RAIL_WIDTHS.topics;
    railEl.style.width = `${railWidth}px`;
    document.documentElement.style.setProperty(
      '--pagetollm-rail-reserve',
      `${railWidth + IN_PAGE_RAIL_RESERVE_GAP}px`,
    );
    document.documentElement.style.setProperty('--pagetollm-rail-width', `${railWidth}px`);
  };

  document.documentElement.appendChild(railEl);
  trackMountedSurface();
  railSurfaceTracked = true;
  activeRailController = {
    railEl,
    teardown() {
      railClosed = true;
      railRoot.unmount();
      railEl.remove();
      if (railSurfaceTracked) {
        railSurfaceTracked = false;
        untrackMountedSurface();
      }
      if (onTeardown) onTeardown();
      document.body.classList.remove('pagetollm-rail-open');
      document.documentElement.style.removeProperty('--pagetollm-rail-reserve');
      document.documentElement.style.removeProperty('--pagetollm-rail-width');
    },
  };

  // Reserve space on the right side of the page so the rail does not overlap text.
  setRailWidthForMode();
  document.body.classList.add('pagetollm-rail-open');

  return { railEl, railRoot, setRailWidthForMode, isClosed: () => railClosed };
}

export function closeInPageRail() {
  railLoadingTokenHolder.current = null;
  if (activeRailController) {
    try {
      activeRailController.teardown();
    } catch (_) {
      /* noop */
    }
    activeRailController = null;
  }
  document.querySelectorAll('#pagetollm-in-page-rail').forEach((railEl) => railEl.remove());
  document.body.classList.remove('pagetollm-rail-open');
  document.documentElement.style.removeProperty('--pagetollm-rail-reserve');
  document.documentElement.style.removeProperty('--pagetollm-rail-width');
}
