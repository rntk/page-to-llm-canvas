/**
 * Formats thrown values, including values that are not Error instances.
 * @param {unknown} error
 * @returns {string}
 */
export function errorMessage(error) {
  return (error && error.message) || String(error);
}
