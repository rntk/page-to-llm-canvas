/**
 * runtimeMessages.js
 *
 * Single shared wrapper around `chrome.runtime.sendMessage` /
 * `chrome.tabs.sendMessage` used by every caller in this extension that
 * talks to the background service worker (or a content script). Unifies the
 * error semantics that used to be duplicated (and inconsistently
 * implemented) across popup.js, optionsApi.js, recordFetch.js, useRecord.js
 * and errorUtils.js:
 *
 *   - If `chrome.runtime.lastError` is set when the response callback
 *     fires, the returned promise REJECTS with
 *     `new Error(chrome.runtime.lastError.message)`.
 *   - Otherwise the promise resolves with the raw response passed to the
 *     callback (no normalization/validation of the payload shape).
 *
 * Callers that need different behavior (e.g. resolving null instead of
 * rejecting) should wrap these helpers rather than reimplementing the
 * underlying sendMessage/lastError plumbing.
 */

/**
 * Send a message to the extension's background service worker.
 *
 * @param {*} message
 * @returns {Promise<*>} resolves with the raw response, rejects with an
 *   Error(chrome.runtime.lastError.message) when lastError is set.
 */
export function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

/**
 * Send a message to a specific tab (e.g. a content script).
 *
 * @param {number} tabId
 * @param {*} message
 * @returns {Promise<*>} resolves with the raw response, rejects with an
 *   Error(chrome.runtime.lastError.message) when lastError is set.
 */
export function sendTabMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

/**
 * Chrome-backed runtime-messaging capability for browser composition roots.
 *
 * Only `send` is here: the tab-directed variant is used exclusively from the
 * service worker, which imports `sendTabMessage` directly rather than taking an
 * injected messenger.
 */
export const browserRuntimeMessenger = Object.freeze({
  send: sendRuntimeMessage,
});
