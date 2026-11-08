/**
 * Lowercased unicode word tokens; diacritics are folded away.
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  return (
    String(text ?? '')
      .normalize('NFKD')
      .replace(/\p{M}+/gu, '')
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) || []
  );
}
