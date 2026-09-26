import { splitSentenceRuns } from '../domain/topicDomain.js';

/**
 * Build one menu item per contiguous sentence run represented by a topic card.
 * @param {Array<object>} actions Topic actions to offer.
 * @param {string} path Topic path.
 * @param {number[]} sentences Sentence numbers represented by the card.
 * @returns {{topic: object, actions: Array<object>}|null} Menu data, if available.
 */
export function buildTopicRunMenu(actions, path, sentences) {
  if (!actions?.length) return null;
  const runs = splitSentenceRuns(sentences);
  if (!runs.length) return null;

  const targetForRun = (run) => ({
    path,
    startSentence: run[0],
    endSentence: run[run.length - 1],
  });
  const topic = targetForRun(runs[0]);
  if (runs.length === 1) return { topic, actions };

  return {
    topic,
    actions: runs.flatMap((run, index) => {
      const target = targetForRun(run);
      return actions.map((action) => ({
        ...action,
        id: `${action.id}-${index}`,
        label: `${action.label} sentences ${target.startSentence}–${target.endSentence}`,
        title: () => action.title?.(target),
        onSelect: () => action.onSelect(target),
      }));
    }),
  };
}
