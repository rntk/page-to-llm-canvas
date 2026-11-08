// Summary-tree strategy for a project: the primary topics of several saved
// pages are the sources, merged under grouping topics of the project's own.

import { PRIMARY_TOPICS_SOURCE } from '../pipeline/summaryTreePrompts.js';
import { isGroupNode } from './projectTopicTree.js';

/**
 * @param {object} input
 * @param {object} input.seed From `buildProjectTopicSeed`, possibly the increment of a finished tree.
 * @param {object|null} input.prior Saved tree to resume or extend.
 * @param {string} input.contentRevision Revision of the current pages.
 * @param {boolean} [input.extending] The saved tree already holds the seed's nodes.
 */
export function createProjectStrategy({ seed, prior, contentRevision, extending = false }) {
  return {
    sentences: seed.sentences,
    contentRevision,
    prior,
    sourceKind: PRIMARY_TOPICS_SOURCE,
    groupSmallRoot: true,
    seedNodes: () => (extending ? {} : structuredClone(seed.nodes)),
    seedIds: () => new Set(extending ? [] : Object.keys(seed.nodes)),
    isSource: (node) => Boolean(node.recordKey),
    groupIds: (nodes) => seed.sourceTopicIds.filter((id) => nodes[id]),
    isBranch: isGroupNode,
    sourceOf: (node) =>
      node.recordKey
        ? { recordKey: node.recordKey, title: node.sourceTitle || '', url: node.sourceUrl || '' }
        : null,
  };
}
