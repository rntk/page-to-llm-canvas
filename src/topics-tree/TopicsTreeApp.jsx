import React, { useCallback, useEffect, useRef, useState } from 'react';
import { projectArticleView } from '../domain/articleView.js';
import { useRecord } from '../canvas/hooks/useRecord.js';
import { getYouTubeVideoId } from '../utils/youtubeTimestamp.js';
import { PIPELINE_STATUS } from '../shared/runtime/contracts.js';
import {
  TOPIC_SOURCE,
  useQuestionTreeActions,
  useQuestionTreeState,
  useSummaryTreeActions,
  useSummaryTreeState,
} from '../shared/topicSource.js';
import TopicSourceSwitcher from '../components/TopicSourceSwitcher.jsx';
import { LEAF_KIND } from './displayTree.js';
import RecordStateGate from './RecordStateGate.jsx';
import { TREE_SOURCES, useSourceTree } from './treeSources.js';
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
  const [source, setSource] = useState(TOPIC_SOURCE.PIPELINE);
  const sourceConfig = TREE_SOURCES[source];
  const isQuestionSource = source === TOPIC_SOURCE.QUESTIONS;
  const summaryTree = useSummaryTreeState(record);
  const summaryTreeActions = useSummaryTreeActions(recordSource, initialKey);
  const questionTree = useQuestionTreeState(record);
  const questionTreeActions = useQuestionTreeActions(recordSource, initialKey);
  const activeTree = isQuestionSource ? questionTree : summaryTree;
  const treeActions = isQuestionSource ? questionTreeActions : summaryTreeActions;

  const article = projectArticleView(record);
  const leafChat = useSourceCardChats({
    sentences: article.sentences,
    record,
    recordKey: initialKey,
  });
  const sourceUrl = record?.sourceUrl;
  const { tree, canvasKey } = useSourceTree(sourceConfig, initialKey, record, activeTree);
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
          <TopicSourceSwitcher
            className="th-page__level-switcher tt-source-switcher"
            source={source}
            onChange={setSource}
          />
        )}
        <div className="tt-bar-controls" ref={setControlsHost} />
        {record?.status === PIPELINE_STATUS.DONE && SourceBar && (
          <SourceBar status={activeTree.status} tree={activeTree.tree} {...treeActions} />
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
          {sourceConfig.showCanvas(activeTree) &&
            (canvas ||
              (sourceConfig.emptyText && (
                <div className="th-page__state">{sourceConfig.emptyText(activeTree.status)}</div>
              )))}
        </RecordStateGate>
      </div>
    </div>
  );
}
