import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { projectArticleView } from '../domain/articleView.js';
import { useRecord } from '../canvas/hooks/useRecord.js';
import { getYouTubeVideoId } from '../utils/youtubeTimestamp.js';
import { splitError } from '../utils/errorUtils.js';
import ErrorDetails from '../components/ErrorDetails.jsx';
import { PIPELINE_STATUS } from '../shared/runtime/contracts.js';
import { articleRootTitle, buildTopicsDisplayTree } from './topicsTreeModel.js';
import TopicsTreeCanvas from './TopicsTreeCanvas.jsx';
import '../hierarchy/hierarchy.css';
import './topics-tree.css';

const noop = () => {};

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

  const article = projectArticleView(record);
  // Serialize on record identity changes so polling does not rebuild an unchanged tree.
  const treeInputJson = useMemo(
    () => JSON.stringify([record?.topics || null, record?.topic_summary_index || null]),
    [record?.topics, record?.topic_summary_index],
  );
  const sourceUrl = record?.sourceUrl;
  const tree = useMemo(() => {
    const [topics, summaryIndex] = JSON.parse(treeInputJson);
    return buildTopicsDisplayTree(topics, summaryIndex, {
      title: articleRootTitle(sourceUrl),
    });
  }, [treeInputJson, sourceUrl]);
  const isYouTube = Boolean(getYouTubeVideoId(sourceUrl));

  const handleShowInPage = useCallback(
    (node) => {
      onNavigateToSentences({
        key: initialKey,
        rail: isYouTube ? 'youtube' : 'page',
        sentenceNumbers: node.sentences,
        level: node.depth - 1,
        topicPath: node.path,
      });
    },
    [onNavigateToSentences, initialKey, isYouTube],
  );

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
  } else if (!tree) {
    body = <div className="th-page__state">No topics were found for this page.</div>;
  } else {
    body = (
      <TopicsTreeCanvas
        key={`${initialKey}:${treeInputJson}`}
        tree={tree}
        sentences={article.sentences}
        onShowInPage={handleShowInPage}
      />
    );
  }

  // The host removes the iframe asynchronously after the effect above.
  if (isDeleted) return null;

  return (
    <div className="th-page tt-page">
      <header className="th-page__bar">
        <h1 className="th-page__title">Topics Tree</h1>
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
