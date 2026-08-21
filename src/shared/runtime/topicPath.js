/**
 * The single owner of the topic-path delimiter.
 *
 * A topic path encodes its hierarchy in the topic name itself. Two spellings
 * are in use and they are NOT interchangeable:
 *
 *   - canonical/wire form, `A>B>C` — what the worker pipeline produces and what
 *     `topic.name` / `topic_summary_index` keys are stored as.
 *   - display form, `A > B > C` — what the frontend renders and what card
 *     `path` / `fullPath` values (and the indexes keyed by them) use.
 *
 * `splitTopicPath` accepts either; the two joiners are deliberately separate so
 * a call site has to say which side of the seam it is on.
 */

/** Delimiter in canonical/wire topic paths (`A>B`). */
export const TOPIC_PATH_DELIMITER = '>';

/** Delimiter in display topic paths (`A > B`). */
export const TOPIC_PATH_DISPLAY_DELIMITER = ' > ';

/**
 * Split a hierarchical topic path into normalized path segments. Accepts both
 * the canonical and the display spelling; blank segments are dropped.
 *
 * @param {string} name
 * @returns {string[]}
 */
export function splitTopicPath(name) {
  return String(name || '')
    .split(TOPIC_PATH_DELIMITER)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Join segments into a canonical/wire topic path (`A>B>C`).
 *
 * @param {string[]} parts
 * @returns {string}
 */
export function joinTopicPath(parts) {
  return parts.join(TOPIC_PATH_DELIMITER);
}

/**
 * Join segments into a display topic path (`A > B > C`).
 *
 * @param {string[]} parts
 * @returns {string}
 */
export function formatTopicPath(parts) {
  return parts.join(TOPIC_PATH_DISPLAY_DELIMITER);
}

/**
 * Every proper ancestor of a DISPLAY-form path, shallowest first: `A > B > C`
 * yields `['A', 'A > B']`. The path itself is never included.
 *
 * Scans for the delimiter instead of splitting and re-joining so a path that is
 * not in display form (`A>B`) yields no ancestors rather than inventing them —
 * these results feed "does this path have a descendant?" set membership, where
 * a fabricated ancestor silently drops a card.
 *
 * @param {string} path Display-form topic path.
 * @returns {string[]}
 */
export function ancestorPaths(path) {
  const out = [];
  if (!path) return out;
  let sep = path.indexOf(TOPIC_PATH_DISPLAY_DELIMITER);
  while (sep !== -1) {
    out.push(path.slice(0, sep));
    sep = path.indexOf(TOPIC_PATH_DISPLAY_DELIMITER, sep + TOPIC_PATH_DISPLAY_DELIMITER.length);
  }
  return out;
}

/**
 * True when `path` is a strict descendant of `ancestor` in display form.
 * Equal paths are not descendants.
 *
 * @param {string} path Display-form topic path.
 * @param {string} ancestor Display-form topic path.
 * @returns {boolean}
 */
export function isDescendantPath(path, ancestor) {
  if (!path || !ancestor) return false;
  return path.startsWith(ancestor + TOPIC_PATH_DISPLAY_DELIMITER);
}

/**
 * True when `path` is a strict descendant of `ancestor` in canonical/wire form.
 * Equal paths are not descendants. The worker-side counterpart of
 * isDescendantPath — note the empty root path is never treated as an ancestor.
 *
 * @param {string} path Canonical topic path.
 * @param {string} ancestor Canonical topic path.
 * @returns {boolean}
 */
export function isCanonicalDescendantPath(path, ancestor) {
  if (!path || !ancestor) return false;
  return path.startsWith(ancestor + TOPIC_PATH_DELIMITER);
}
