/**
 * Utility function to split a pipeline error stack trace or message.
 * Extracts the first line as the clean error message, and the rest as details.
 * Hardened to safely handle non-string values.
 *
 * @param {*} recordError - The raw error value to split.
 * @returns {{ message: string, details: string }}
 */
export function splitError(recordError) {
  const errorStr = recordError == null ? '' : String(recordError);
  if (!errorStr) {
    return { message: '', details: '' };
  }
  const index = errorStr.indexOf('\n');
  if (index === -1) {
    return { message: errorStr, details: '' };
  }
  return {
    message: errorStr.slice(0, index),
    details: errorStr.slice(index + 1),
  };
}

/**
 * Shared helper to send a retryRecord message to the background service worker.
 *
 * @param {string} key - The unique storage key for the record.
 * @param {string} [serviceName] - The name of the calling service (for logs).
 * @returns {Promise<object>}
 */
export function retryRecord(key, serviceName = 'Canvas') {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'retryRecord', key }, (resp) => {
      if (chrome.runtime.lastError) {
        console.warn(`PageToLLM ${serviceName} retry error:`, chrome.runtime.lastError.message);
        reject(new Error(chrome.runtime.lastError.message));
      } else if (resp && !resp.ok) {
        console.warn(`PageToLLM ${serviceName} retry failed:`, resp.error);
        reject(new Error(resp.error || 'Retry failed'));
      } else {
        resolve(resp);
      }
    });
  });
}
