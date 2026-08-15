import { ACTION_ICON_PATHS } from '../../../worker/actionIcon.js';

/**
 * Adapt service-worker browser APIs to the action-icon controller interface.
 * Keeping this glue separate makes the Web API availability and asset-loading
 * branches testable without importing the background composition root.
 *
 * @param {object} options
 * @param {function(): Promise<object[]>} options.records
 * @param {object} options.actionApi
 * @param {object} options.runtimeApi
 * @param {object} options.globalScope
 * @param {object} options.logger
 * @returns {object} Dependencies for createActionIconController.
 */
export function createActionIconDependencies({
  records,
  actionApi,
  runtimeApi,
  globalScope,
  logger,
}) {
  return {
    records,
    actionApi,
    assets: {
      paths: ACTION_ICON_PATHS,
      loadBitmap: async (path) => {
        const response = await globalScope.fetch(runtimeApi.getURL(path));
        return globalScope.createImageBitmap(await response.blob());
      },
    },
    canvasFactory: (width, height) =>
      typeof globalScope.OffscreenCanvas === 'function' &&
      typeof globalScope.createImageBitmap === 'function'
        ? new globalScope.OffscreenCanvas(width, height)
        : null,
    // Web IDL timer methods require the worker global as their receiver. These
    // wrappers preserve that receiver when the controller calls through the
    // scheduler object.
    scheduler: {
      setTimeout: (...args) => globalScope.setTimeout(...args),
      clearTimeout: (timer) => globalScope.clearTimeout(timer),
    },
    logger,
  };
}
