const EMPTY_ARRAY = Object.freeze([]);

/**
 * Label for an article's root node; records do not carry a title.
 * @param {string} [sourceUrl] Record source URL.
 * @returns {string}
 */
export function articleRootTitle(sourceUrl) {
  try {
    return new URL(sourceUrl).hostname || 'Article';
  } catch (_) {
    return 'Article';
  }
}

/**
 * Small display projection of an external/persisted article record. Arrays are
 * always present for rendering; entries still belong to the source and must be
 * treated as read-only. Topic consumers validate nested topic ranges.
 *
 * Not a pipeline record: an empty display array does not mean extraction or
 * topic detection ran. Never persist it or use it to decide resumability; the
 * original record keeps the absent/null fields, status, revisions and
 * checkpoints needed for processing and export.
 * @param {object|null} [record] Possibly incomplete imported article.
 * @returns {{sentences: Array, topics: Array}} Display collections.
 */
export function projectArticleView(record) {
  return {
    sentences: Array.isArray(record?.sentences) ? record.sentences : EMPTY_ARRAY,
    topics: Array.isArray(record?.topics) ? record.topics : EMPTY_ARRAY,
  };
}
