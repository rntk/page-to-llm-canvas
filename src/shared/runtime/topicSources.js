export const TOPIC_SOURCE = Object.freeze({
  PIPELINE: 'pipeline',
  SUMMARY_TREE: 'summary_tree',
});

export const TOPIC_SOURCE_LABELS = Object.freeze({
  [TOPIC_SOURCE.PIPELINE]: 'Pipeline',
  [TOPIC_SOURCE.SUMMARY_TREE]: 'Summary tree',
});

export const TOPIC_SOURCE_IDS = Object.freeze(Object.values(TOPIC_SOURCE));
