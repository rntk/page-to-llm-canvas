import { canonicalTopicPath, isCanonicalDescendantPath } from './topicPath.js';

/**
 * Build the standard topic resplit action.
 * `topics` may be an array or a getter to keep the descendant check current.
 */
export function createResplitAction({
  topics = [],
  request,
  onAccepted,
  confirm = globalThis.confirm,
}) {
  const hasSubtopicsInRange = ({ path, startSentence, endSentence }) => {
    const target = canonicalTopicPath(path);
    const currentTopics = typeof topics === 'function' ? topics() : topics;
    return currentTopics.some(
      (topic) =>
        isCanonicalDescendantPath(canonicalTopicPath(topic.name), target) &&
        topic.sentences?.some(
          (sentenceId) => sentenceId >= startSentence && sentenceId <= endSentence,
        ),
    );
  };

  return {
    id: 'resplit',
    label: 'Resplit',
    title: (topic) =>
      hasSubtopicsInRange(topic)
        ? 'Replace this topic and its subtopics within this sentence range.'
        : 'Resplit this topic; its name and subtopics may change.',
    onSelect: async (topic) => {
      if (
        hasSubtopicsInRange(topic) &&
        !confirm(
          'Resplitting may rename this topic and replaces its subtopics within this sentence range. Continue?',
        )
      ) {
        return { ok: true, dismissed: true };
      }
      const response = await request(topic);
      if (response?.ok && !response.stale) onAccepted?.(response, topic);
      return response;
    },
  };
}
