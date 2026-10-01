/**
 * Shared Chrome message wrappers. Resolve with the raw response; reject with
 * Error(lastError.message) when Chrome reports a runtime error.
 */

/**
 * Send a message to the extension's background service worker.
 *
 * @param {*} message
 * @returns {Promise<*>} Raw response, or rejection on runtime.lastError.
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
 * @returns {Promise<*>} Raw response, or rejection on runtime.lastError.
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
 * Chrome runtime messenger for browser composition roots. Tab messaging is
 * imported directly by the service worker.
 */
export const browserRuntimeMessenger = Object.freeze({
  send: sendRuntimeMessage,
});
