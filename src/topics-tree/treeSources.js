import { useMemo } from 'react';
import { articleRootTitle } from '../domain/articleView.js';
import { SUMMARY_TREE_STATUS } from '../shared/runtime/summaryTree.js';
import { TOPIC_SOURCE, TOPIC_SOURCE_LABELS, summaryTreeRevision } from '../shared/topicSource.js';
import SummaryTreeBar from './SummaryTreeBar.jsx';
import { buildSummaryTreeDisplayTree, buildTopicsDisplayTree } from './displayTree.js';

export const TREE_SOURCES = Object.freeze({
  [TOPIC_SOURCE.PIPELINE]: {
    label: TOPIC_SOURCE_LABELS[TOPIC_SOURCE.PIPELINE],
    inputOf: (record) => [record?.topics, record?.topic_summary_index],
    revisionOf: (record) => record?.topicsRevision,
    build: ([topics, summaries], options) => buildTopicsDisplayTree(topics, summaries, options),
    topicPath: (node) => node.path,
    showCanvas: () => true,
    emptyText: 'No topics were found for this page.',
  },
  [TOPIC_SOURCE.SUMMARY_TREE]: {
    label: TOPIC_SOURCE_LABELS[TOPIC_SOURCE.SUMMARY_TREE],
    inputOf: (_record, summaryTree) => [summaryTree.tree?.rootId, summaryTree.tree?.nodes],
    revisionOf: (_record, summaryTree) => summaryTreeRevision(summaryTree),
    build: ([rootId, nodes], options) => buildSummaryTreeDisplayTree({ rootId, nodes }, options),
    // Summary tree paths are not record topics.
    topicPath: () => undefined,
    // Saves arrive while running; show the settled tree when the build stops.
    showCanvas: (summaryTree) => summaryTree.status !== SUMMARY_TREE_STATUS.RUNNING,
    Bar: SummaryTreeBar,
  },
});
export const TREE_SOURCE_IDS = Object.freeze(Object.keys(TREE_SOURCES));

let nextCanvasKey = 0;

/**
 * Build only when the selected source's saved revision changes.
 * @param {object} source Source registry entry.
 * @param {string} recordKey Record identity, including records without a saved key.
 * @param {object|null} record Saved article.
 * @param {object} summaryTree Effective summary tree state.
 */
export function useSourceTree(source, recordKey, record, summaryTree) {
  const input = source.inputOf(record, summaryTree);
  const revision = source.revisionOf(record, summaryTree);
  const title = articleRootTitle(record?.sourceUrl);
  // Older records and in-memory callers may lack revision markers.
  const first = revision == null ? input[0] : null;
  const second = revision == null ? input[1] : null;
  return useMemo(
    () => ({ tree: source.build(input, { title }), canvasKey: ++nextCanvasKey }),
    // Saved revisions cover the input; polling creates fresh objects for unchanged data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [source, recordKey, record?.contentRevision, revision, first, second, title],
  );
}
