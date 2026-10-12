import { buildTopicSentenceIndex } from '../domain/topicDomain.js';
import { formatTopicPath, splitTopicPath } from '../shared/runtime/topicPath.js';

/** Normalize menu and saved scope paths to the sentence index's display format.
 * @param {string[]} scope Selected topic paths.
 * @returns {string[]} Unique normalized paths.
 */
export function normalizeChatScope(scope) {
  return [
    ...new Set(
      (Array.isArray(scope) ? scope : [])
        .filter((path) => typeof path === 'string')
        .map((path) => formatTopicPath(splitTopicPath(path)))
        .filter(Boolean),
    ),
  ];
}

/** Keep document line numbers while excluding text outside the selected topics.
 * @param {string[]} sentences Source sentences.
 * @param {object[]} topics Document topics.
 * @param {string[]} scope Selected topic paths; empty means the whole document.
 * @returns {string[]} Number-preserving source for chat.
 */
export function scopeChatSentences(sentences, topics, scope) {
  if (!scope.length) return sentences;
  const index = buildTopicSentenceIndex(topics);
  const included = new Set(
    normalizeChatScope(scope).flatMap((path) => [...(index.get(path) || [])]),
  );
  return sentences.map((sentence, index) => (included.has(index + 1) ? sentence : ''));
}

/** Create a topic-wide chat action, including recurring runs and descendants.
 * @param {Function} onSelect Opens a scoped chat.
 * @returns {object} Topic menu action.
 */
export function createToChatAction(onSelect) {
  return { id: 'to-chat', label: 'To chat', wholeTopic: true, onSelect };
}
