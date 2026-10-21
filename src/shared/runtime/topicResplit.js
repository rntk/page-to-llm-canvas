import { canonicalTopicPath, isCanonicalDescendantPath } from './topicPath.js';
import { showResplitInstructionsDialog } from '../dom/resplitInstructionsDialog.js';

/**
 * Build the standard topic resplit action.
 * `topics` may be an array or a getter to keep the descendant check current.
 */
export function createResplitAction({
  topics = [],
  request,
  onAccepted,
  getInstructions = showResplitInstructionsDialog,
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
      const instructions = await getInstructions({
        topic,
        hasSubtopics: hasSubtopicsInRange(topic),
      });
      if (!instructions) {
        return { ok: true, dismissed: true };
      }
      const response = await request({ ...topic, ...instructions });
      if (response?.ok && !response.stale) onAccepted?.(response, topic);
      return response;
    },
  };
}
