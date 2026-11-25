/**
 * Topic sources for the topics tree, canvas and hierarchy views: pipeline topics,
 * the summary tree, or the question tree built beside them.
 */

import { useCallback, useMemo, useState } from 'react';
import { projectQuestionTreeTopics } from '../domain/questionTreeTopicProjection.js';
import { projectSummaryTreeTopics } from '../domain/summaryTreeTopicProjection.js';
import { QUESTION_TREE_STATUS, readQuestionTree } from './runtime/questionTree.js';
import { readSummaryTree, SUMMARY_TREE_STATUS } from './runtime/summaryTree.js';
import { useStaleTick } from './useStaleTick.js';

export const TOPIC_SOURCE = Object.freeze({
  PIPELINE: 'pipeline',
  SUMMARY_TREE: 'summary_tree',
  QUESTIONS: 'questions',
});

export const TOPIC_SOURCE_LABELS = Object.freeze({
  [TOPIC_SOURCE.PIPELINE]: 'Pipeline',
  [TOPIC_SOURCE.SUMMARY_TREE]: 'Summary tree',
  [TOPIC_SOURCE.QUESTIONS]: 'Questions',
});

export const TOPIC_SOURCE_IDS = Object.freeze(Object.values(TOPIC_SOURCE));

/**
 * Saved revision of a summary or question tree. A terminal save can share a
 * millisecond with the last running checkpoint, so the status is part of it.
 * @param {{tree: object|null}|null|undefined} state Effective tree state.
 * @returns {string|undefined}
 */
export function summaryTreeRevision(state) {
  const tree = state?.tree;
  return Number.isFinite(tree?.updatedAt) ? `${tree.updatedAt}:${tree.status}` : undefined;
}

/**
 * Whether the saved tree can be shown. Saves arrive while a build runs;
 * views show the settled tree once it stops.
 * @param {{status: string, tree: object|null}|null|undefined} state Effective tree state.
 * @returns {boolean}
 */
export function isSummaryTreeShowable(state) {
  return Boolean(state?.tree) && state.status !== SUMMARY_TREE_STATUS.RUNNING;
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
 * Text shown in place of the topics while the question tree cannot be shown.
 * @param {string} status Effective question tree status.
 * @returns {string}
 */
export function questionTreeEmptyText(status) {
  if (status === QUESTION_TREE_STATUS.RUNNING) {
    return 'The questions are being found. They appear here when the build finishes.';
  }
  if (status === QUESTION_TREE_STATUS.MISSING) {
    return 'No questions have been found for this page yet.';
  }
  return 'The question view has no questions yet. Resume or rebuild it.';
}

/**
 * The record as seen through a topic source. Alternative sources replace the
 * topics and their summaries; the rest of the record is kept. Returns null
 * when the selected alternative tree is missing, running, or empty.
 * @param {object|null} record Saved article.
 * @param {string} source Topic source id.
 * @param {{status: string, tree: object|null}} summaryTree Effective summary tree state.
 * @param {{status: string, tree: object|null}|null} [questionTree] Effective question tree state.
 * @returns {object|null}
 */
export function recordForTopicSource(record, source, summaryTree, questionTree = null) {
  if (source === TOPIC_SOURCE.SUMMARY_TREE) {
    if (!record || !isSummaryTreeShowable(summaryTree)) return null;
    const projected = projectSummaryTreeTopics(summaryTree.tree);
    if (!projected) return null;
    // The summary tree carries its own summaries, even when the pipeline skipped them.
    return { ...record, ...projected, summariesDisabled: false };
  }
  if (source === TOPIC_SOURCE.QUESTIONS) {
    if (!record || !isSummaryTreeShowable(questionTree)) return null;
    const projected = projectQuestionTreeTopics(questionTree.tree, record.sentences);
    if (!projected) return null;
    return { ...record, ...projected, summariesDisabled: false };
  }
  return record;
}

function useTreeState(rawTree, expectedContentRevision, readTree) {
  const [now, setNow] = useState(() => Date.now());
  const state = readTree(rawTree, expectedContentRevision, now);
  // A save newer than `now` is never stale, so ticking only while running suffices.
  const running = state.status === SUMMARY_TREE_STATUS.RUNNING;
  const tick = useCallback(() => setNow(Date.now()), []);
  useStaleTick(running, tick);
  return state;
}

/**
 * The record's effective summary tree state. A running build that stops
 * saving is reported as interrupted once stale, without a record change.
 * @param {object|null} record Saved article.
 * @returns {{status: string, tree: object|null}}
 */
export function useSummaryTreeState(record) {
  return useTreeState(record?.summary_tree, record?.contentRevision, readSummaryTree);
}

/**
 * The record's effective question tree state.
 * @param {object|null} record Saved article.
 * @returns {{status: string, tree: object|null}}
 */
export function useQuestionTreeState(record) {
  return useTreeState(record?.question_tree, record?.contentRevision, readQuestionTree);
}

/**
 * Build and stop requests for a derived tree, with the last request error.
 * Actions are undefined when the record source cannot perform them.
 * @param {object} recordSource
 * @param {string} recordKey
 * @param {{build: string, stop: string}} methods
 * @returns {{notice: string, onBuild?: function({fresh: boolean}): void, onStop?: function(): void}}
 */
export function useTreeBuildActions(recordSource, recordKey, { build, stop }) {
  const [notice, setNotice] = useState('');
  const send = (request) => {
    setNotice('');
    Promise.resolve(request())
      .then((response) => {
        if (response?.ok === false) setNotice(String(response.error || 'Request failed.'));
      })
      .catch((err) => setNotice(String(err?.message || err)));
  };
  const buildFn = recordSource?.[build];
  const stopFn = recordSource?.[stop];
  const onBuild =
    typeof buildFn === 'function'
      ? ({ fresh }) => send(() => buildFn.call(recordSource, recordKey, { fresh }))
      : undefined;
  const onStop =
    typeof stopFn === 'function' ? () => send(() => stopFn.call(recordSource, recordKey)) : undefined;
  return { notice, onBuild, onStop };
}

/**
 * Build and stop requests for the summary tree.
 * @param {object} recordSource
 * @param {string} recordKey
 * @returns {{notice: string, onBuild?: function({fresh: boolean}): void, onStop?: function(): void}}
 */
export function useSummaryTreeActions(recordSource, recordKey) {
  return useTreeBuildActions(recordSource, recordKey, {
    build: 'buildSummaryTree',
    stop: 'stopSummaryTree',
  });
}

/**
 * Build and stop requests for the question tree.
 * @param {object} recordSource
 * @param {string} recordKey
 * @returns {{notice: string, onBuild?: function({fresh: boolean}): void, onStop?: function(): void}}
 */
export function useQuestionTreeActions(recordSource, recordKey) {
  return useTreeBuildActions(recordSource, recordKey, {
    build: 'buildQuestionTree',
    stop: 'stopQuestionTree',
  });
}

/**
 * The record seen through the selected source, recomputed only when the
 * record or the selected tree changes.
 * @param {object|null} record Saved article.
 * @param {string} source Topic source id.
 * @param {{status: string, tree: object|null}} summaryTree Effective summary tree state.
 * @param {{status: string, tree: object|null}|null} [questionTree] Effective question tree state.
 * @returns {object|null}
 */
export function useTopicSourceRecord(record, source, summaryTree, questionTree = null) {
  const activeTree =
    source === TOPIC_SOURCE.QUESTIONS
      ? questionTree
      : source === TOPIC_SOURCE.SUMMARY_TREE
        ? summaryTree
        : null;
  const revision = activeTree ? summaryTreeRevision(activeTree) : undefined;
  const showable = activeTree ? isSummaryTreeShowable(activeTree) : false;
  // Older trees may lack `updatedAt`; then the tree object itself is the revision.
  const treeIdentity = activeTree && revision == null ? activeTree.tree : null;
  return useMemo(
    () => recordForTopicSource(record, source, summaryTree, questionTree),
    // The revision covers the active tree; polling creates fresh objects for unchanged data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [record, source, revision, showable, treeIdentity],
  );
}
