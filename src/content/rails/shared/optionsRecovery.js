/**
 * Shared "send the user to Options" routine for content rails.
 *
 * Failed, cancelled, and parked (`needs_attention`) analyses can only be
 * retried/skipped from the Options page, so every rail routes those lifecycle
 * outcomes here rather than telling the user to wait.
 *
 * Content scripts cannot open Options themselves: `options.html` is not
 * web-accessible (so a page-context `window.open` is blocked even though it
 * returns a handle) and `chrome.runtime.openOptionsPage` is not exposed to
 * content scripts. The worker owns that capability, so ask it.
 */

import { MSG } from '../../../shared/runtime/messages.js';

/**
 * @param {{
 *   runtimeMessenger: { send: function(object): Promise<object|null> },
 *   alert: function(string): void,
 *   logger?: { warn: Function },
 * }} deps
 * @returns {function(): Promise<void>}
 */
export function createOptionsRecoveryOpener({ runtimeMessenger, alert, logger }) {
  return async function openOptionsForRecovery() {
    try {
      const resp = await runtimeMessenger.send({ type: MSG.openOptionsPage });
      if (resp?.ok === true) return;
      logger?.warn?.('open options failed:', resp?.error ?? 'unexpected response');
    } catch (error) {
      logger?.warn?.('open options failed:', error);
    }
    alert('PageToLLM: Open the extension Options page to review this analysis.');
  };
}
