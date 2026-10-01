/**
 * Route failed, cancelled, or parked analyses to Options for recovery.
 * Content scripts ask the worker to open Options because they cannot do so.
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
