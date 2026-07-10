import React, { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import { useRecord } from '../useRecord.js';
import TopicHierarchyView from './TopicHierarchyView.jsx';
import { getSentencesForNode } from './hierarchyUtils.js';
import { getYouTubeTimestampLink, getYouTubeVideoId } from '../utils/youtubeTimestamp.js';
import YouTubeTimestampButton from '../components/YouTubeTimestampButton.jsx';
import { closeModal, postMessageToParent } from '../closeModal.js';
import { splitError, retryRecord } from '../utils/errorUtils.js';
import ErrorDetails from '../components/ErrorDetails.jsx';
import TopicLevelSwitcher from '../components/TopicLevelSwitcher.jsx';
import { buildTopicTree, collectNonLeafPaths } from '../utils/topicTree.js';
import { getMaxTopicLevel } from '../topicCards.js';
import './hierarchy.css';

export default function HierarchyApp({ initialKey }) {
  const { record, error } = useRecord(initialKey);
  const bodyRef = useRef(null);

  const [prevInitialKey, setPrevInitialKey] = useState(initialKey);
  const [collapsedPaths, setCollapsedPaths] = useState(() => new Set());
  // `null` means "follow the deepest level" so the view starts fully unfolded
  // (leaf level selected) and tracks maxLevel until the user picks a level —
  // important because `topics` (and thus maxLevel) load asynchronously.
  const [selectedLevel, setSelectedLevel] = useState(null);
  const [activeSummary, setActiveSummary] = useState(null);

  useEffect(() => {
    // The hierarchy runs inside an iframe. Pull focus into the iframe and onto
    // the scrollable body so keyboard scrolling (Page Up/Down, arrow keys, etc.)
    // works immediately without requiring an extra click.
    try {
      window.focus();
    } catch (_) {
      /* noop */
    }
    const body = bodyRef.current;
    if (body && typeof body.focus === 'function') {
      body.focus({ preventScroll: true });
    }
  }, []);

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        if (activeSummary) {
          event.preventDefault();
          setActiveSummary(null);
        } else {
          closeModal();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [activeSummary]);

  const handleRetry = useCallback(() => {
    if (!initialKey) return;
    retryRecord(initialKey, 'Hierarchy').catch(() => {});
  }, [initialKey]);

  // Serialize once per record change, not once per render: `record` is stable across
  // UI renders (only storage writes mint a new object), so keying on the reference
  // avoids re-stringifying topics on every unrelated re-render while still re-running
  // on real record updates. The downstream `topics` memo keeps content-dedup via the string.
  const topicsJson = useMemo(() => JSON.stringify(record?.topics || null), [record?.topics]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const topics = useMemo(() => (Array.isArray(record?.topics) ? record.topics : []), [topicsJson]);
  const isDone = record?.status === 'done';
  const isRecordError = record?.status === 'error' || record?.status === 'cancelled';
  const isNeedsAttention = record?.status === 'needs_attention';

  const handleSummaryClick = useCallback((summaryData) => {
    setActiveSummary(summaryData);
  }, []);

  const isYouTube = useMemo(
    () => Boolean(getYouTubeVideoId(record?.sourceUrl)),
    [record?.sourceUrl],
  );
  const activeSummaryYouTubeLink = useMemo(
    () =>
      isYouTube && activeSummary
        ? getYouTubeTimestampLink({
            sourceUrl: record?.sourceUrl,
            sentences: record?.sentences,
            sourceSentences: activeSummary.sourceSentences,
          })
        : null,
    [isYouTube, activeSummary, record?.sourceUrl, record?.sentences],
  );

  if (initialKey !== prevInitialKey) {
    setPrevInitialKey(initialKey);
    setCollapsedPaths(new Set());
    setSelectedLevel(null);
    setActiveSummary(null);
  }

  const roots = useMemo(() => buildTopicTree(topics, 0), [topics]);
  const maxLevel = useMemo(() => getMaxTopicLevel(topics), [topics]);
  const effectiveLevel = selectedLevel === null ? maxLevel : selectedLevel;

  // Fold the tree down to `level`: collapse every branch at that depth or deeper
  // so only levels 0..level stay visible, mirroring the canvas rail's level pick.
  const handleSelectLevel = useCallback(
    (level) => {
      setSelectedLevel(level);
      setCollapsedPaths(new Set(collectNonLeafPaths(roots, { minDepth: level })));
    },
    [roots],
  );

  const handleToggleCollapse = useCallback((fullPath) => {
    setCollapsedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(fullPath)) {
        next.delete(fullPath);
      } else {
        next.add(fullPath);
      }
      return next;
    });
  }, []);

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
        collapsedPaths={collapsedPaths}
        onToggleCollapse={handleToggleCollapse}
        sourceUrl={record?.sourceUrl}
        sentences={record?.sentences}
        onTopicClick={(entry) => {
          const sentenceNumbers = getSentencesForNode(entry);
          try {
            postMessageToParent({
              type: 'pagetollm-scroll-to-topic-sentences',
              key: initialKey,
              sentenceNumbers,
              level: entry.node.depth,
              topicPath: entry.node.fullPath,
            });
          } catch (_) {
            /* noop */
          }
        }}
        onSummaryClick={handleSummaryClick}
      />
    );
  }

  return (
    <div className="th-page">
      <header className="th-page__bar">
        <h1 className="th-page__title">Topic Hierarchy and Summaries</h1>
        <div className="th-page__actions">
          {isDone && topics.length > 0 && maxLevel > 0 && (
            <TopicLevelSwitcher
              className="th-page__level-switcher"
              selectedLevel={effectiveLevel}
              maxLevel={maxLevel}
              onChange={handleSelectLevel}
            />
          )}
        </div>
        <button
          type="button"
          className="th-page__close"
          onClick={closeModal}
          aria-label="Close"
          title="Close"
        >
          ×
        </button>
      </header>
      <div className="th-page__content">
        <div className="th-page__hierarchy-pane">
          <div ref={bodyRef} className="th-page__body" tabIndex={-1}>
            {body}
          </div>
        </div>
      </div>
      {activeSummary && (
        <div className="th-summary-modal-overlay" onClick={() => setActiveSummary(null)}>
          <div
            className="th-summary-modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="th-summary-modal-title"
          >
            <button
              type="button"
              className="th-summary-modal__close-btn"
              onClick={() => setActiveSummary(null)}
              aria-label="Close summary modal"
            >
              ×
            </button>
            <article className="th-summary-modal__card">
              <header className="th-summary-modal__card-header">
                <div className="th-summary-modal__card-title-block">
                  <span className="th-summary-modal__card-kicker">Summary</span>
                  <span id="th-summary-modal-title" className="th-summary-modal__card-path">
                    {activeSummary.path}
                  </span>
                </div>
                {activeSummaryYouTubeLink && (
                  <YouTubeTimestampButton link={activeSummaryYouTubeLink} />
                )}
              </header>
              {activeSummary.text && (
                <div className="th-summary-modal__text-container">
                  <p className="th-summary-modal__card-text">{activeSummary.text}</p>
                </div>
              )}
            </article>
          </div>
        </div>
      )}
    </div>
  );
}
