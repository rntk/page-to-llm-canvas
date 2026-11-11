import React, { useCallback, useEffect, useRef, useState } from 'react';
import { projectArticleView } from '../domain/articleView.js';
import { useRecord } from '../canvas/hooks/useRecord.js';
import { getYouTubeVideoId } from '../utils/youtubeTimestamp.js';
import { PIPELINE_STATUS } from '../shared/runtime/contracts.js';
import { readSummaryTree, SUMMARY_TREE_STATUS } from '../shared/runtime/summaryTree.js';
import { useStaleTick } from '../shared/useStaleTick.js';
import TopicLevelSwitcher from '../components/TopicLevelSwitcher.jsx';
import { LEAF_KIND } from './displayTree.js';
import RecordStateGate from './RecordStateGate.jsx';
import { TREE_SOURCES, TREE_SOURCE_IDS, useSourceTree } from './treeSources.js';
import TopicsTreeCanvas from './TopicsTreeCanvas.jsx';
import { useSourceCardChats } from './useSourceCardChats.js';
import '../extension/styles/topic-page.css';
import './topics-tree.css';

const noop = () => {};

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
  const [source, setSource] = useState(TREE_SOURCE_IDS[0]);
  const [notice, setNotice] = useState('');
  const sourceConfig = TREE_SOURCES[source];
  const [now, setNow] = useState(() => Date.now());
  const summaryTree = readSummaryTree(record?.summary_tree, record?.contentRevision, now);

  // A running build that stops saving becomes resumable without a record change.
  // A save newer than `now` is never stale, so ticking only while running suffices.
  const running = summaryTree.status === SUMMARY_TREE_STATUS.RUNNING;
  const tick = useCallback(() => setNow(Date.now()), []);
  useStaleTick(running, tick);

  const article = projectArticleView(record);
  const leafChat = useSourceCardChats({
    sentences: article.sentences,
    record,
    recordKey: initialKey,
  });
  const sourceUrl = record?.sourceUrl;
  const { tree, canvasKey } = useSourceTree(sourceConfig, initialKey, record, summaryTree);
  const isYouTube = Boolean(getYouTubeVideoId(sourceUrl));

  const handleShowInPage = useCallback(
    (node) => {
      onNavigateToSentences({
        key: initialKey,
        rail: isYouTube ? 'youtube' : 'page',
        sentenceNumbers: node.sentences,
        // Source leaves sit one level below the topic whose path they carry.
        level: Math.max(0, node.depth - (node.kind === LEAF_KIND ? 2 : 1)),
        topicPath: sourceConfig.topicPath(node),
      });
    },
    [onNavigateToSentences, initialKey, isYouTube, sourceConfig],
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

  const SourceBar = sourceConfig.Bar;
  const canvas = tree ? (
    <TopicsTreeCanvas
      key={`${initialKey}:${source}:${canvasKey}`}
      tree={tree}
      sentences={article.sentences}
      leafChat={leafChat}
      onShowInPage={handleShowInPage}
      controlsHost={controlsHost}
    />
  ) : null;

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
            selectedLevel={TREE_SOURCE_IDS.indexOf(source)}
            maxLevel={TREE_SOURCE_IDS.length - 1}
            getOptionLabel={(index) => TREE_SOURCES[TREE_SOURCE_IDS[index]].label}
            onChange={(index) => setSource(TREE_SOURCE_IDS[index])}
          />
        )}
        <div className="tt-bar-controls" ref={setControlsHost} />
        {record?.status === PIPELINE_STATUS.DONE && SourceBar && (
          <SourceBar
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
      <div className="tt-page__body">
        <RecordStateGate record={record} error={error} onClose={onClose}>
          {sourceConfig.showCanvas(summaryTree) &&
            (canvas ||
              (sourceConfig.emptyText && (
                <div className="th-page__state">{sourceConfig.emptyText}</div>
              )))}
        </RecordStateGate>
      </div>
    </div>
  );
}
