/**
 * Splits one oversized text unit into bounded pieces, preferring a nearby word
 * boundary without allowing a very early boundary to create tiny fragments.
 * Shared by every LLM surface so oversized-unit behavior cannot drift.
 *
 * @param {string} text Text to split.
 * @param {number} maxChars Maximum characters per piece.
 * @param {object} [options]
 * @param {boolean} [options.preserveWhitespace=false] Retain split whitespace
 *   exactly instead of normalizing it between pieces.
 * @returns {string[]}
 */
export function splitTextToMaxChars(text, maxChars, { preserveWhitespace = false } = {}) {
  if (!Number.isFinite(maxChars) || maxChars <= 0) {
    throw new Error('maxChars must be positive');
  }
  const parts = [];
  let remaining = String(text || '');
  while (remaining.length > maxChars) {
    const boundarySearchEnd = preserveWhitespace ? maxChars - 1 : maxChars;
    let splitAt = remaining.lastIndexOf(' ', boundarySearchEnd);
    if (splitAt < Math.floor(maxChars / 2)) splitAt = maxChars;
    else if (preserveWhitespace) splitAt += 1;
    const part = preserveWhitespace
      ? remaining.slice(0, splitAt)
      : remaining.slice(0, splitAt).trim();
    if (part) parts.push(part);
    remaining = preserveWhitespace
      ? remaining.slice(splitAt)
      : remaining.slice(splitAt).trimStart();
  }
  if (remaining) parts.push(remaining);
  return parts;
}
