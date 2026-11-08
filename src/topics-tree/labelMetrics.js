import { LEAF_KIND } from './displayTree.js';

/**
 * Font size grows with the share of the article a topic covers, like a word tree.
 * @param {object} node Display node.
 * @param {number} totalSentences Sentences covered by the whole tree.
 */
export function labelSize(node, totalSentences) {
  if (node.kind === LEAF_KIND) return 14;
  const share = totalSentences > 0 ? node.sentences.length / totalSentences : 0;
  return Math.round(15 + 21 * Math.sqrt(Math.min(1, share)));
}

/**
 * Wrap width for a topic label: bigger type gets a wider line, within sane bounds.
 * @param {number} fontSize Title font size in px.
 */
export function topicMaxWidth(fontSize) {
  return Math.max(420, Math.min(680, Math.round(fontSize * 20)));
}
