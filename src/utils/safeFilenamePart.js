/**
 * Sanitize an arbitrary value (usually a record key/URL) into a filename
 * fragment. Keeps only `[a-z0-9._-]`, trims leading/trailing separators and
 * caps the length, so a URL key cannot smuggle path separators into a
 * download filename.
 *
 * @param {string|number|null|undefined} value
 * @returns {string}
 */
export function safeFilenamePart(value) {
  const cleaned = String(value || 'record')
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return cleaned || 'record';
}
