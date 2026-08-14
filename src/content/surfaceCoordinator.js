import { createSelectionController } from './selection/controller.jsx';
import { createRailSurfaceManager } from './rails/shared/surface.js';
import { createInPageRailController } from './rails/in-page/controller.jsx';
import { createYouTubeRailController } from './rails/youtube/controller.jsx';
import { createRecordFrameManager } from './record-view/iframeManager.js';
import { browserRuntimeMessenger } from '../utils/runtimeMessages.js';

const defaultRuntimeMessenger = {
  ...browserRuntimeMessenger,
  getURL: (path) => globalThis.chrome.runtime.getURL(path),
  ...(typeof globalThis.chrome?.runtime?.openOptionsPage === 'function'
    ? { openOptionsPage: () => globalThis.chrome.runtime.openOptionsPage() }
    : {}),
};
const defaultDialogs = {
  alert: (...args) => globalThis.alert(...args),
  confirm: (...args) => globalThis.confirm(...args),
};

/**
 * Coordinates the mutually-exclusive UI surfaces owned by a content script.
 */
export function createContentSurfaceCoordinator({
  document,
  rootFactory,
  preferences,
  runtimeMessenger = defaultRuntimeMessenger,
  dialogs = defaultDialogs,
} = {}) {
  let activeSurface = null;
  let pendingRailRequest = null;
  const railManager = createRailSurfaceManager({ document, rootFactory, preferences });
  const frameManager = createRecordFrameManager({
    document,
    getRuntimeUrl: runtimeMessenger.getURL,
  });

  function closeActiveSurface() {
    const surface = activeSurface;
    activeSurface = null;
    pendingRailRequest = null;
    if (surface?.kind === 'selection') surface.controller.destroy();
    // Managers own their resources and close idempotently. Closing both also
    // invalidates an in-flight rail load that has not mounted a surface yet.
    railManager.close();
    frameManager.close();
  }

  function openSelection() {
    closeActiveSurface();
    const controller = createSelectionController({
      document,
      window: document.defaultView,
      rootFactory,
      preferences,
      runtimeMessenger,
      dialogs,
      onDestroy: () => {
        if (activeSurface?.controller === controller) activeSurface = null;
      },
    });
    activeSurface = { kind: 'selection', controller };
    return controller;
  }

  function openRecordFrame(key, view) {
    closeActiveSurface();
    const frame = frameManager.open(key, view);
    activeSurface = { kind: 'record-frame' };
    return frame;
  }

  const { openInPageRail } = createInPageRailController({
    surfaceManager: railManager,
    openRecordFrame,
    document,
    window: document.defaultView,
    runtimeMessenger,
    dialogs,
    onDestroy: () => {
      // Self-initiated rail closes arrive after mounting and reconcile the
      // coordinator's state here; coordinator-initiated closes clear it first.
      if (activeSurface?.kind === 'rail') activeSurface = null;
    },
  });
  const { openYouTubeRail } = createYouTubeRailController({
    surfaceManager: railManager,
    document,
    runtimeMessenger,
    dialogs,
    onDestroy: () => {
      if (activeSurface?.kind === 'rail') activeSurface = null;
    },
  });

  async function openRail(rec, mode, rail, options = {}) {
    closeActiveSurface();
    const request = {};
    pendingRailRequest = request;
    try {
      const mounted =
        rail === 'youtube'
          ? await openYouTubeRail(rec, mode, options)
          : await openInPageRail(rec, mode, options);
      if (pendingRailRequest !== request) return false;
      pendingRailRequest = null;
      if (mounted) activeSurface = { kind: 'rail' };
      return mounted;
    } catch (err) {
      if (pendingRailRequest === request) pendingRailRequest = null;
      throw err;
    }
  }

  function destroy() {
    closeActiveSurface();
    railManager.dispose();
  }

  return {
    openSelection,
    openRail,
    openRecordFrame,
    closeActiveSurface,
    getRecordFrame: frameManager.getActiveFrame,
    destroy,
  };
}
