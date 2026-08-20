/**
 * Formats a stored metrics timestamp for display.
 *
 * @param {number|string|null|undefined} timestamp Epoch millis (or any value
 *   `Date` accepts) recorded for a metrics entry.
 * @param {string} [fallback] Text to use when `timestamp` is falsy. Defaults
 *   to an em dash to match most metrics tables; pass `''` to match sections
 *   that render nothing instead.
 * @returns {string}
 */
export function formatDate(timestamp, fallback = '—') {
  return timestamp ? new Date(timestamp).toLocaleString() : fallback;
}
