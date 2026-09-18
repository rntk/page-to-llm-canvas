import { MSG } from '../../../shared/runtime/messages.js';

/**
 * Handlers that open extension pages on behalf of content scripts.
 *
 * `options.html` is deliberately not web-accessible, so a page-context
 * `window.open` on it is blocked, and `chrome.runtime.openOptionsPage` is not
 * exposed to content scripts. Content rails therefore ask the worker to open
 * Options for them (failed/cancelled/parked analyses can only be retried or
 * skipped there).
 *
 * @param {object} deps
 * @param {function(): Promise<void>} deps.openOptionsPage
 */
export function createNavigationHandlers({ openOptionsPage }) {
  return {
    [MSG.openOptionsPage]: {
      requiresExtensionPage: false,
      validate: () => null,
      async handle() {
        await openOptionsPage();
        return { ok: true };
      },
    },
  };
}
