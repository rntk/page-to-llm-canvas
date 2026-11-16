/**
 * Topic sources for the topics tree, canvas and hierarchy views: pipeline topics
 * or the summary tree built beside them. Owns the summary tree's effective state,
 * build actions, and the record views read `record.topics` and `record.topic_summary_index` from.
 */

import { useCallback, useMemo, useState } from 'react';
import { projectSummaryTreeTopics } from '../domain/summaryTreeTopicProjection.js';
import { readSummaryTree, SUMMARY_TREE_STATUS } from './runtime/summaryTree.js';
import { useStaleTick } from './useStaleTick.js';

export const TOPIC_SOURCE = Object.freeze({
  PIPELINE: 'pipeline',
  SUMMARY_TREE: 'summary_tree',
});

export const TOPIC_SOURCE_LABELS = Object.freeze({
  [TOPIC_SOURCE.PIPELINE]: 'Pipeline',
  [TOPIC_SOURCE.SUMMARY_TREE]: 'Summary tree',
});

export const TOPIC_SOURCE_IDS = Object.freeze(Object.values(TOPIC_SOURCE));

/**
 * Saved revision of a summary tree. A terminal save can share a millisecond
 * with the last running checkpoint, so the status is part of it.
 * @param {{tree: object|null}} summaryTree Effective summary tree state.
 * @returns {string|undefined}
 */
export function summaryTreeRevision({ tree }) {
  return Number.isFinite(tree?.updatedAt) ? `${tree.updatedAt}:${tree.status}` : undefined;
}

/**
 * Whether the saved summary tree can be shown. Saves arrive while a build
 * runs; views show the settled tree once it stops.
 * @param {{status: string, tree: object|null}} summaryTree Effective summary tree state.
 */
export function isSummaryTreeShowable(summaryTree) {
  return Boolean(summaryTree.tree) && summaryTree.status !== SUMMARY_TREE_STATUS.RUNNING;
}

/**
 * Text shown in place of the topics while the summary tree cannot be shown.
 * @param {string} status Effective summary tree status.
 * @returns {string}
 */
export function summaryTreeEmptyText(status) {
  if (status === SUMMARY_TREE_STATUS.RUNNING) {
    return 'The summary tree is being built. It appears here when the build finishes.';
  }
  if (status === SUMMARY_TREE_STATUS.MISSING) {
    return 'No summary tree has been built for this page yet.';
  }
  return 'The summary tree has no topics yet. Resume or rebuild it.';
}

/**
 * The record as seen through a topic source. The summary tree replaces the
 * topics and their summaries; the rest of the record is kept. Returns null
 * when the summary tree is missing, running, or has no structure yet.
 * @param {object|null} record Saved article.
 * @param {string} source Topic source id.
 * @param {{status: string, tree: object|null}} summaryTree Effective summary tree state.
 * @returns {object|null}
 */
export function recordForTopicSource(record, source, summaryTree) {
  if (source !== TOPIC_SOURCE.SUMMARY_TREE) return record;
  if (!record || !isSummaryTreeShowable(summaryTree)) return null;
  const projected = projectSummaryTreeTopics(summaryTree.tree);
  if (!projected) return null;
  // The summary tree carries its own summaries, even when the pipeline skipped them.
  return { ...record, ...projected, summariesDisabled: false };
}

/**
 * The record's effective summary tree state. A running build that stops
 * saving is reported as interrupted once stale, without a record change.
 * @param {object|null} record Saved article.
 * @returns {{status: string, tree: object|null}}
 */
export function useSummaryTreeState(record) {
  const [now, setNow] = useState(() => Date.now());
  const summaryTree = readSummaryTree(record?.summary_tree, record?.contentRevision, now);
  // A save newer than `now` is never stale, so ticking only while running suffices.
  const running = summaryTree.status === SUMMARY_TREE_STATUS.RUNNING;
  const tick = useCallback(() => setNow(Date.now()), []);
  useStaleTick(running, tick);
  return summaryTree;
}

/**
 * Build and stop requests for the summary tree, with the last request error.
 * Actions are undefined when the record source cannot perform them.
 * @param {object} recordSource
 * @param {string} recordKey
 * @returns {{notice: string, onBuild?: function({fresh: boolean}): void, onStop?: function(): void}}
 */
export function useSummaryTreeActions(recordSource, recordKey) {
  const [notice, setNotice] = useState('');
  const send = (request) => {
    setNotice('');
    Promise.resolve(request())
      .then((response) => {
        if (response?.ok === false) setNotice(String(response.error || 'Request failed.'));
      })
      .catch((err) => setNotice(String(err?.message || err)));
  };
  const onBuild =
    typeof recordSource?.buildSummaryTree === 'function'
      ? ({ fresh }) => send(() => recordSource.buildSummaryTree(recordKey, { fresh }))
      : undefined;
  const onStop =
    typeof recordSource?.stopSummaryTree === 'function'
      ? () => send(() => recordSource.stopSummaryTree(recordKey))
      : undefined;
  return { notice, onBuild, onStop };
}

/**
 * The record seen through the selected source, recomputed only when the
 * record or the saved summary tree changes.
 * @param {object|null} record Saved article.
 * @param {string} source Topic source id.
 * @param {{status: string, tree: object|null}} summaryTree Effective summary tree state.
 * @returns {object|null}
 */
export function useTopicSourceRecord(record, source, summaryTree) {
  const revision = summaryTreeRevision(summaryTree);
  const showable = isSummaryTreeShowable(summaryTree);
  // Older trees may lack `updatedAt`; then the tree object itself is the revision.
  const treeIdentity = revision == null ? summaryTree.tree : null;
  return useMemo(
    () => recordForTopicSource(record, source, summaryTree),
    // The revision covers the tree; polling creates fresh objects for unchanged data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [record, source, revision, showable, treeIdentity],
  );
}
