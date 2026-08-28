/**
 * Coordinates the mutually-exclusive UI surfaces owned by a content script.
 * Surface implementations are async loaders so the always-injected bundle
 * does not parse React or surface code until it is requested.
 */
export function createContentSurfaceCoordinator({
  document,
  runtimeMessenger,
  dialogs,
  loaders,
} = {}) {
  let activeSurface = null;
  let pendingRequest = null;
  let selectionController = null;
  const railSurfaces = {
    inPage: { current: null, pending: null },
    youtube: { current: null, pending: null },
  };
  let frameManager = null;

  function closeActiveSurface() {
    activeSurface = null;
    pendingRequest = null;
    selectionController?.destroy();
    selectionController = null;
    // Closing both managers also invalidates a rail fetch that has not mounted.
    railSurfaces.inPage.current?.close();
    railSurfaces.youtube.current?.close();
    frameManager?.close();
  }

  async function openSelection() {
    closeActiveSurface();
    const request = {};
    pendingRequest = request;
    const { createSelectionSurface } = await loaders.selection();
    if (pendingRequest !== request) return false;

    let controller;
    controller = await createSelectionSurface({
      document,
      runtimeMessenger,
      dialogs,
      onDestroy: () => {
        if (selectionController === controller) selectionController = null;
        if (activeSurface?.controller === controller) activeSurface = null;
      },
    });
    if (pendingRequest !== request) {
      controller.destroy();
      return false;
    }
    selectionController = controller;
    pendingRequest = null;
    activeSurface = { kind: 'selection', controller };
    return controller;
  }

  async function openRecordFrame(key, view) {
    closeActiveSurface();
    const request = {};
    pendingRequest = request;
    const { createRecordFrameSurface } = await loaders.recordFrame();
    if (pendingRequest !== request) return false;

    frameManager ??= createRecordFrameSurface({ document, runtimeMessenger });
    const frame = frameManager.open(key, view);
    pendingRequest = null;
    activeSurface = { kind: 'record-frame' };
    return frame;
  }

  function getRailSurface(kind) {
    const isYouTube = kind === 'youtube';
    const state = isYouTube ? railSurfaces.youtube : railSurfaces.inPage;
    if (state.current) return Promise.resolve(state.current);

    if (!state.pending) {
      const load = isYouTube ? loaders.youTubeRail : loaders.inPageRail;
      state.pending = Promise.resolve()
        .then(load)
        .then((module) => {
          const onDestroy = () => {
            if (activeSurface?.kind === 'rail') activeSurface = null;
          };
          return isYouTube
            ? module.createYouTubeRailSurface({
                document,
                runtimeMessenger,
                dialogs,
                onDestroy,
              })
            : module.createInPageRailSurface({
                document,
                runtimeMessenger,
                dialogs,
                openRecordFrame: (...args) => {
                  void openRecordFrame(...args).catch((err) => {
                    console.error('PageToLLM record view error:', err);
                    dialogs?.alert?.(
                      'PageToLLM: Unable to open this view. Reload the page and try again.',
                    );
                  });
                },
                onDestroy,
              });
        })
        .then((surface) => {
          state.current = surface;
          return surface;
        })
        .catch((err) => {
          // A transient extension update/import failure must not poison this
          // page for the remainder of its lifetime.
          state.pending = null;
          throw err;
        });
    }
    return state.pending;
  }

  async function openRail(rec, mode, rail, options = {}) {
    closeActiveSurface();
    const request = {};
    pendingRequest = request;
    try {
      const surface = await getRailSurface(rail);
      if (pendingRequest !== request) return false;
      const mounted = await surface.open(rec, mode, options);
      if (pendingRequest !== request) return false;
      pendingRequest = null;
      if (mounted) activeSurface = { kind: 'rail' };
      return mounted;
    } catch (err) {
      if (pendingRequest === request) pendingRequest = null;
      throw err;
    }
  }

  function destroy() {
    closeActiveSurface();
    railSurfaces.inPage.current?.destroy();
    railSurfaces.youtube.current?.destroy();
    railSurfaces.inPage = { current: null, pending: null };
    railSurfaces.youtube = { current: null, pending: null };
    frameManager = null;
  }

  return {
    openSelection,
    openRail,
    openRecordFrame,
    closeActiveSurface,
    getRecordFrame: () => frameManager?.getActiveFrame() ?? null,
    destroy,
  };
}
