// What a summary tree is built from. The stage drives summarizing, grouping and
// checkpointing; a strategy supplies the material and says which nodes are
// sources and which are grouping branches, so the stage never inspects
// strategy-specific node fields.
//
// A strategy provides:
// - sentences, contentRevision, prior: the rows cited, their revision, and the saved `summary_tree`.
// - sourceKind, groupSmallRoot: grouping options (see `buildTopics`).
// - seedNodes({maxChars}): nodes of a fresh build; seedIds(): the ones a resume keeps before grouping completes.
// - isSource(node): nodes summarized first, straight from their sentences.
// - groupIds(nodes): the summarized units that grouping arranges under the root.
// - isBranch(node): grouping branches a new unit can be placed under.
// - sourceOf(node): origin shown to the model beside a child's claims, or null.

import { splitTopicPath } from '../../shared/runtime/topicPath.js';
import { PASSAGE, TOPIC, createPassage } from './summaryTreeModel.js';
import {
  PASSAGE_MAX_CHARS,
  PASSAGE_MIN_CHARS,
  PASSAGE_TARGET_CHARS,
  buildPassages,
} from './summaryTreePassages.js';

function fallbackTitle(sentences, topics) {
  const first = sentences[0];
  const topic = (Array.isArray(topics) ? topics : []).find((item) =>
    item?.sentences?.includes(first),
  );
  const name = topic ? splitTopicPath(topic.name).at(-1) : '';
  return name || `Sentences ${first}–${sentences.at(-1)}`;
}

/**
 * Strategy for one article: its passages are grouped into topics.
 * @param {object} record Record with `sentences`, `topics`, `contentRevision`, and `summary_tree`.
 */
export function createArticleStrategy(record) {
  return {
    sentences: record?.sentences,
    contentRevision: record?.contentRevision,
    prior: record?.summary_tree,
    sourceKind: null,
    groupSmallRoot: false,
    seedNodes({ maxChars }) {
      const nodes = {};
      const passageMaxChars = Math.min(PASSAGE_MAX_CHARS, maxChars);
      const passages = buildPassages(record.sentences, record.topics, {
        targetChars: Math.min(PASSAGE_TARGET_CHARS, Math.floor(passageMaxChars / 2)),
        minChars: Math.min(PASSAGE_MIN_CHARS, Math.floor(passageMaxChars / 4)),
        maxChars: passageMaxChars,
      });
      for (const sentences of passages) {
        createPassage(nodes, fallbackTitle(sentences, record.topics), sentences);
      }
      return nodes;
    },
    seedIds: () => new Set(),
    isSource: (node) => node.kind === PASSAGE,
    groupIds: (nodes) =>
      Object.values(nodes)
        .filter((node) => node.kind === PASSAGE)
        .map((node) => node.id),
    isBranch: (node) => node.kind === TOPIC,
    sourceOf: () => null,
  };
}
