/**
 * Cap text at `maxChars`, keeping its head and tail around a middle "…".
 * @param {string} text Text to fit.
 * @param {number} maxChars Maximum length of the result.
 * @returns {string}
 */
export function fitTextToChars(text, maxChars) {
  const value = String(text || '');
  if (value.length <= maxChars) return value;
  if (maxChars <= 1) return value.slice(0, maxChars);
  const separator = '…';
  const retained = maxChars - separator.length;
  const headLength = Math.ceil(retained / 2);
  return `${value.slice(0, headLength)}${separator}${value.slice(value.length - (retained - headLength))}`;
}
