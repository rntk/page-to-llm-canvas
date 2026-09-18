const EMPTY_ARRAY = Object.freeze([]);

/**
 * Small display projection of an external/persisted article record. Arrays are
 * always available for rendering; their entries still belong to the source and
 * must be treated as read-only. Topic consumers validate nested topic ranges.
 *
 * This is deliberately not a pipeline record: an empty display array does not
 * establish that extraction or topic detection ran. The original record retains
 * absent/null fields, status, revisions, and checkpoints for processing decisions
 * and export. Never persist this projection or use it to decide resumability.
 * @param {object|null} [record] Possibly incomplete imported article.
 * @returns {{sentences: Array, topics: Array}} Display collections.
 */
export function projectArticleView(record) {
  return {
    sentences: Array.isArray(record?.sentences) ? record.sentences : EMPTY_ARRAY,
    topics: Array.isArray(record?.topics) ? record.topics : EMPTY_ARRAY,
  };
}
