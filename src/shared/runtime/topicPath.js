/**
 * The single owner of the topic-path delimiter.
 *
 * A topic path encodes its hierarchy in the name. The two spellings are NOT
 * interchangeable:
 *
 *   - canonical/wire `A>B>C`: produced by the worker; `topic.name` and
 *     `topic_summary_index` keys are stored this way.
 *   - display `A > B > C`: rendered by the frontend; card `path`/`fullPath` use it.
 *
 * `splitTopicPath` accepts either. The two joiners are separate so each call site
 * states which side it is on.
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
 * Normalize either spelling of a topic path to its canonical/wire form.
 *
 * @param {string} name
 * @returns {string}
 */
export function canonicalTopicPath(name) {
  return joinTopicPath(splitTopicPath(name));
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
 * Proper ancestors of a DISPLAY-form path, shallowest first: `A > B > C` yields
 * `['A', 'A > B']`.
 *
 * Scans for the display delimiter rather than splitting, so a canonical `A>B`
 * yields nothing. A fabricated ancestor would silently drop a card from
 * descendant-set lookups.
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
