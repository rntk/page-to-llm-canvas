import React, { useMemo, useCallback, useEffect } from 'react';
import { useRecord } from '../useRecord.js';
import TopicHierarchyView from './TopicHierarchyView.jsx';
import { getSentencesForNode } from './hierarchyUtils.js';
import { closeModal } from '../closeModal.js';
import { splitError, retryRecord } from '../utils/errorUtils.js';
import ErrorDetails from '../components/ErrorDetails.jsx';
import './hierarchy.css';

export default function HierarchyApp({ initialKey }) {
  const { record, error } = useRecord(initialKey);

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        closeModal();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  const handleRetry = useCallback(() => {
    if (!initialKey) return;
    retryRecord(initialKey, 'Hierarchy').catch(() => {});
  }, [initialKey]);

  const topics = useMemo(() => (Array.isArray(record?.topics) ? record.topics : []), [record]);
  const isDone = record?.status === 'done';
  const isRecordError = record?.status === 'error';
  const isNeedsAttention = record?.status === 'needs_attention';

  let body;
  if (error && !record) {
    body = <div className="th-page__state">Error: {String(error)}</div>;
  } else if (!record) {
    body = <div className="th-page__state">Loading…</div>;
  } else if (isRecordError) {
    const { message, details } = splitError(
      record?.error || 'Unknown error occurred during processing.',
    );
    body = (
      <div className="th-page__state th-page__state--error" role="alert">
        <div className="th-page__error-title">Processing Failed</div>
        <ErrorDetails
          message={message}
          details={details}
          msgClassName="th-page__error-message"
          detailsClassName="th-page__error-details"
        />
        <div className="th-page__error-actions">
          <button type="button" className="th-page__retry-btn" onClick={handleRetry}>
            Retry
          </button>
          <button type="button" className="th-page__close-btn" onClick={closeModal}>
            Close
          </button>
        </div>
      </div>
    );
  } else if (isNeedsAttention) {
    const count = Array.isArray(record?.summaryErrors) ? record.summaryErrors.length : 0;
    body = (
      <div className="th-page__state th-page__state--error" role="alert">
        <div className="th-page__error-title">
          {count === 1 ? '1 topic needs attention' : `${count} topics need attention`}
        </div>
        <div className="th-page__error-message">
          Some topics could not be summarized after several retries. Open the canvas view to retry
          or skip them.
        </div>
        <div className="th-page__error-actions">
          <button type="button" className="th-page__close-btn" onClick={closeModal}>
            Close
          </button>
        </div>
      </div>
    );
  } else if (!isDone) {
    body = <div className="th-page__state">Still processing this page…</div>;
  } else {
    body = (
      <TopicHierarchyView
        topics={topics}
        topicSummaries={record?.topic_summaries}
        topicSummaryIndex={record?.topic_summary_index}
        onTopicClick={(entry) => {
          const sentenceNumbers = getSentencesForNode(entry);
          try {
            window.parent.postMessage(
              {
                type: 'pagetollm-scroll-to-topic-sentences',
                key: initialKey,
                sentenceNumbers,
                level: entry.node.depth,
                topicPath: entry.node.fullPath,
              },
              '*',
            );
          } catch (_) {
            /* noop */
          }
        }}
      />
    );
  }

  return (
    <div className="th-page">
      <header className="th-page__bar">
        <h1 className="th-page__title">Topic Hierarchy and Summaries</h1>
        <button type="button" className="th-page__close" onClick={closeModal} title="Close">
          ×
        </button>
      </header>
      <div className="th-page__content">
        <div className="th-page__hierarchy-pane">
          <div className="th-page__body">{body}</div>
        </div>
      </div>
    </div>
  );
}
