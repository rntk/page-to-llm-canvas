/**
 * FNV-1a over JavaScript UTF-16 code units, returned as an unsigned integer.
 * This is a compact deterministic fingerprint, not a cryptographic hash.
 * @param {string} text
 * @returns {number}
 */
export function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
  }
  return hash >>> 0;
}
