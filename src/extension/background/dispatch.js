/**
 * Builds the pure dispatch function over an explicit handler registry.
 *
 * The returned `dispatchMessage` owns: unknown-type handling, extension-page
 * sender gating, per-handler validation, and try/catch wrapping. It always
 * resolves.
 *
 * @param {object} deps
 * @param {Record<string, {requiresExtensionPage: boolean, validate: Function, handle: Function}>} deps.handlers
 *   Default registry, used when a caller does not pass its own.
 * @param {function(object): boolean} deps.isExtensionPageSender
 * @returns {function(object, object, object=): Promise<object>}
 */
export function createDispatcher({ handlers: defaultHandlers, isExtensionPageSender }) {
  /**
   * Precondition: msg is non-null and has a non-empty `type` field.
   * (The `no type` short-circuit is the listener's responsibility so it can
   * return `false` synchronously in that case.)
   *
   * @param {object} msg
   * @param {object} sender
   * @param {*} [handlers]
   * @returns {Promise<object>}
   */
  return async function dispatchMessage(msg, sender, handlers = defaultHandlers) {
    const entry = Object.hasOwn(handlers, msg.type) ? handlers[msg.type] : undefined;
    if (!entry) {
      return { ok: false, error: 'unknown type: ' + msg.type };
    }

    if (entry.requiresExtensionPage && !isExtensionPageSender(sender)) {
      return { ok: false, error: 'this action is only available to trusted extension pages' };
    }

    const validationError = entry.validate(msg);
    if (validationError) {
      return { ok: false, error: validationError };
    }

    try {
      return await entry.handle(msg, sender);
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  };
}
