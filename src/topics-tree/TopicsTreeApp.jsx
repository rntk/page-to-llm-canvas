import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { projectArticleView } from '../domain/articleView.js';
import { useRecord } from '../canvas/hooks/useRecord.js';
import { getYouTubeVideoId } from '../utils/youtubeTimestamp.js';
import { splitError } from '../utils/errorUtils.js';
import ErrorDetails from '../components/ErrorDetails.jsx';
import { PIPELINE_STATUS } from '../shared/runtime/contracts.js';
import {
  readSummaryTree,
  SUMMARY_TREE_STAGE,
  SUMMARY_TREE_STALE_MS,
  SUMMARY_TREE_STATUS,
} from '../shared/runtime/summaryTree.js';
import TopicLevelSwitcher from '../components/TopicLevelSwitcher.jsx';
import {
  articleRootTitle,
  buildSummaryTreeDisplayTree,
  buildTopicsDisplayTree,
  LEAF_KIND,
} from './topicsTreeModel.js';
import TopicsTreeCanvas from './TopicsTreeCanvas.jsx';
import { useSourceCardChats } from './useSourceCardChats.js';
import '../hierarchy/hierarchy.css';
import './topics-tree.css';

const noop = () => {};

// Which topics and summaries the tree shows: the pipeline's, or the summary
// tree built beside them.
const TREE_SOURCES = Object.freeze(['pipeline', 'summary_tree']);
const SOURCE_LABELS = { pipeline: 'Pipeline', summary_tree: 'Summary tree' };

const STAGE_LABELS = {
  [SUMMARY_TREE_STAGE.PASSAGES]: 'Summarizing passages',
  [SUMMARY_TREE_STAGE.TOPICS]: 'Grouping topics',
  [SUMMARY_TREE_STAGE.SUMMARIES]: 'Summarizing topics',
};

function progressText(tree) {
  const label = STAGE_LABELS[tree?.stage] || 'Starting';
  const { done = 0, total = 0 } = tree?.progress || {};
  return total > 0 ? `${label} ${done}/${total}…` : `${label}…`;
}

/**
 * Status and actions of the summary tree build, shown in the page bar.
 * @param {object} props
 * @param {string} props.status Effective summary tree status.
 * @param {object|null} props.tree Saved summary tree.
 * @param {string} props.notice Last action error.
 * @param {function({fresh: boolean}): void} [props.onBuild]
 * @param {function(): void} [props.onStop]
 */
function SummaryTreeBar({ status, tree, notice, onBuild, onStop }) {
  let text;
  const actions = [];
  const action = (label, onClick, title) =>
    onClick &&
    actions.push(
      <button key={label} type="button" className="tt-btn" title={title} onClick={onClick}>
        {label}
      </button>,
    );
  const build = onBuild && (() => onBuild({ fresh: false }));
  const rebuild = onBuild && (() => onBuild({ fresh: true }));
  switch (status) {
    case SUMMARY_TREE_STATUS.RUNNING:
      text = progressText(tree);
      action('Stop', onStop);
      break;
    case SUMMARY_TREE_STATUS.DONE: {
      const metrics = tree?.metrics || {};
      text = `${metrics.passages ?? 0} passages · ${metrics.topics ?? 0} topics`;
      action('Rebuild', rebuild, 'Build the summary tree again from scratch');
      break;
    }
    case SUMMARY_TREE_STATUS.ERROR:
    case SUMMARY_TREE_STATUS.CANCELLED:
    case SUMMARY_TREE_STATUS.INTERRUPTED:
      text =
        status === SUMMARY_TREE_STATUS.INTERRUPTED
          ? 'The build was interrupted.'
          : status === SUMMARY_TREE_STATUS.CANCELLED
            ? 'The build was stopped.'
            : `The build failed: ${tree?.error || 'unknown error'}`;
      action('Resume', build, 'Continue from the completed summaries');
      action('Rebuild', rebuild, 'Build the summary tree again from scratch');
      break;
    default:
      text =
        'Not built yet. The summary tree groups brief passage summaries into topics and summarizes each level from the one below, citing its sources.';
      action('Build summary tree', build);
  }
  return (
    <div className="tt-source-status" role="status">
      <span className="tt-muted tt-source-status__text" title={text}>
        {text}
      </span>
      {notice && (
        <span className="tt-source-status__notice" title={notice}>
          {notice}
        </span>
      )}
      {actions}
    </div>
  );
}

function ErrorState({ title, message, details, onClose }) {
  return (
    <div className="th-page__state th-page__state--error" role="alert">
      <div className="th-page__error-title">{title}</div>
      {message && (
        <ErrorDetails
          message={message}
          details={details}
          msgClassName="th-page__error-message"
          detailsClassName="th-page__error-details"
        />
      )}
      <div className="th-page__error-message">
        Open the Options page to retry this analysis from the Records section.
      </div>
      <div className="th-page__error-actions">
        <button type="button" className="th-page__close-btn" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

/**
 * Topics tree route: the record's aggregated topic hierarchy with summaries,
 * laid out as a progressive-disclosure tree on a pan/zoom canvas.
 */
export default function TopicsTreeApp({
  initialKey,
  recordSource,
  onClose = noop,
  onNavigateToSentences = noop,
}) {
  const { record, error, isDeleted } = useRecord(initialKey, recordSource);
  const deletionCloseSentRef = useRef(false);

  useEffect(() => {
    if (!isDeleted) {
      deletionCloseSentRef.current = false;
      return;
    }
    if (deletionCloseSentRef.current) return;
    deletionCloseSentRef.current = true;
    onClose();
  }, [isDeleted, onClose]);

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const [controlsHost, setControlsHost] = useState(null);
  const [source, setSource] = useState(TREE_SOURCES[0]);
  const [notice, setNotice] = useState('');
  const isSummaryTree = source === 'summary_tree';
  const [now, setNow] = useState(() => Date.now());
  const summaryTree = readSummaryTree(record, now);

  // A running build that stops saving becomes resumable without a record change.
  // A save newer than `now` is never stale, so ticking only while running suffices.
  const running = summaryTree.status === SUMMARY_TREE_STATUS.RUNNING;
  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => setNow(Date.now()), SUMMARY_TREE_STALE_MS / 4);
    return () => clearInterval(timer);
  }, [running]);

  const article = projectArticleView(record);
  const recordKey = record ? initialKey : null;
  const recordTitle = record?.title || record?.sourceTitle;
  const recordUrl = record?.sourceUrl;
  const recordRevision = record?.contentRevision;
  const chatArticle = useMemo(
    () =>
      recordKey
        ? {
            key: recordKey,
            title: recordTitle || recordUrl || '',
            url: recordUrl || '',
            contentRevision: recordRevision,
          }
        : null,
    [recordKey, recordTitle, recordUrl, recordRevision],
  );
  const leafChat = useSourceCardChats({ sentences: article.sentences, article: chatArticle });
  // Serialize on record identity changes so polling does not rebuild an unchanged tree.
  const treeInputJson = useMemo(
    () =>
      JSON.stringify(
        isSummaryTree
          ? [summaryTree.tree?.rootId || null, summaryTree.tree?.nodes || null]
          : [record?.topics || null, record?.topic_summary_index || null],
      ),
    [isSummaryTree, summaryTree.tree, record?.topics, record?.topic_summary_index],
  );
  const sourceUrl = record?.sourceUrl;
  const tree = useMemo(() => {
    const [first, second] = JSON.parse(treeInputJson);
    const title = articleRootTitle(sourceUrl);
    return isSummaryTree
      ? buildSummaryTreeDisplayTree({ rootId: first, nodes: second }, { title })
      : buildTopicsDisplayTree(first, second, { title });
  }, [treeInputJson, sourceUrl, isSummaryTree]);
  const isYouTube = Boolean(getYouTubeVideoId(sourceUrl));

  const handleShowInPage = useCallback(
    (node) => {
      onNavigateToSentences({
        key: initialKey,
        rail: isYouTube ? 'youtube' : 'page',
        sentenceNumbers: node.sentences,
        // Source leaves sit one level below the topic whose path they carry.
        level: Math.max(0, node.depth - (node.kind === LEAF_KIND ? 2 : 1)),
        // Summary tree paths are not record topics.
        topicPath: isSummaryTree ? undefined : node.path,
      });
    },
    [onNavigateToSentences, initialKey, isYouTube, isSummaryTree],
  );

  const send = (request) => {
    setNotice('');
    Promise.resolve(request())
      .then((response) => {
        if (response?.ok === false) setNotice(String(response.error || 'Request failed.'));
      })
      .catch((err) => setNotice(String(err?.message || err)));
  };
  const handleBuild =
    typeof recordSource?.buildSummaryTree === 'function'
      ? ({ fresh }) => send(() => recordSource.buildSummaryTree(initialKey, { fresh }))
      : undefined;
  const handleStop =
    typeof recordSource?.stopSummaryTree === 'function'
      ? () => send(() => recordSource.stopSummaryTree(initialKey))
      : undefined;

  let body;
  if (error && !record) {
    body = <div className="th-page__state">Error: {String(error)}</div>;
  } else if (!record) {
    body = <div className="th-page__state">Loading…</div>;
  } else if (
    record.status === PIPELINE_STATUS.ERROR ||
    record.status === PIPELINE_STATUS.CANCELLED
  ) {
    const { message, details } = splitError(
      record.error || 'Unknown error occurred during processing.',
    );
    body = (
      <ErrorState title="Processing Failed" message={message} details={details} onClose={onClose} />
    );
  } else if (record.status === PIPELINE_STATUS.NEEDS_ATTENTION) {
    const count = Array.isArray(record.summaryErrors) ? record.summaryErrors.length : 0;
    body = (
      <ErrorState
        title={count === 1 ? '1 topic needs attention' : `${count} topics need attention`}
        onClose={onClose}
      />
    );
  } else if (record.status !== PIPELINE_STATUS.DONE) {
    body = <div className="th-page__state">Still processing this page…</div>;
  } else {
    const canvas = tree ? (
      <TopicsTreeCanvas
        key={`${initialKey}:${source}:${treeInputJson}`}
        tree={tree}
        sentences={article.sentences}
        leafChat={leafChat}
        onShowInPage={handleShowInPage}
        controlsHost={controlsHost}
      />
    ) : null;
    body = isSummaryTree ? (
      // Saves arrive every second while running; remounting would reset the view.
      !running && canvas
    ) : (
      canvas || <div className="th-page__state">No topics were found for this page.</div>
    );
  }

  // The host removes the iframe asynchronously after the effect above.
  if (isDeleted) return null;

  return (
    <div className="th-page tt-page">
      <header className="th-page__bar">
        <h1 className="th-page__title">Topics Tree</h1>
        {record?.status === PIPELINE_STATUS.DONE && (
          <TopicLevelSwitcher
            className="th-page__level-switcher tt-source-switcher"
            label="Topics:"
            selectedLevel={TREE_SOURCES.indexOf(source)}
            maxLevel={TREE_SOURCES.length - 1}
            getOptionLabel={(index) => SOURCE_LABELS[TREE_SOURCES[index]]}
            onChange={(index) => setSource(TREE_SOURCES[index])}
          />
        )}
        <div className="tt-bar-controls" ref={setControlsHost} />
        {record?.status === PIPELINE_STATUS.DONE && isSummaryTree && (
          <SummaryTreeBar
            status={summaryTree.status}
            tree={summaryTree.tree}
            notice={notice}
            onBuild={handleBuild}
            onStop={handleStop}
          />
        )}
        <button
          type="button"
          className="th-page__close"
          onClick={onClose}
          aria-label="Close"
          title="Close"
        >
          ×
        </button>
      </header>
      <div className="tt-page__body">{body}</div>
    </div>
  );
}
