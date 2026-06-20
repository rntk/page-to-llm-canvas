import React from 'react';
import {
  collectWordEntries,
  buildSentenceDomRange,
  buildSentenceWordRanges,
} from '../sentenceHighlight.js';
import { getYouTubeTimestampLink } from '../utils/youtubeTimestamp.js';
import YouTubeTimestampButton from './YouTubeTimestampButton.jsx';

const SENTENCE_PREVIEW_HIDE_DELAY_MS = 120;

function mergeIntervals(intervals) {
  const sorted = intervals
    .filter((interval) => interval.end > interval.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const merged = [];
  for (const interval of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && interval.start <= previous.end) {
      previous.end = Math.max(previous.end, interval.end);
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
}

function preserveWhitespaceGaps(intervals, text) {
  if (intervals.length < 2) return intervals;
  const preserved = [intervals[0]];
  for (const interval of intervals.slice(1)) {
    const previous = preserved[preserved.length - 1];
    const gap = text.slice(previous.end, interval.start);
    if (gap.trim() === '') {
      previous.end = interval.end;
    } else {
      preserved.push(interval);
    }
  }
  return preserved;
}

function pruneEmptyElements(root) {
  const keepEmptyTags = new Set([
    'BR',
    'IMG',
    'HR',
    'IFRAME',
    'VIDEO',
    'AUDIO',
    'SOURCE',
    'PICTURE',
  ]);
  let changed = true;
  while (changed) {
    changed = false;
    Array.from(root.querySelectorAll('*'))
      .reverse()
      .forEach((el) => {
        if (keepEmptyTags.has(el.tagName)) return;
        if (
          el.textContent.trim() === '' &&
          el.querySelector('img, video, audio, iframe') === null
        ) {
          el.remove();
          changed = true;
        }
      });
  }
}

function normalizeSentenceNumbers(sourceSentences, sentenceOffset) {
  return sourceSentences.map((sentenceNumber) => sentenceNumber + sentenceOffset);
}

function buildDomRangesForSentences(sentenceRanges, wordEntries, sourceSentences, sentenceOffset) {
  return normalizeSentenceNumbers(sourceSentences, sentenceOffset)
    .map((sentenceNumber) => buildSentenceDomRange(sentenceRanges, wordEntries, sentenceNumber))
    .filter(Boolean);
}

function splitPreviewIntervals(contextIntervals, highlightIntervals) {
  const boundaries = new Set();
  contextIntervals.forEach((interval) => {
    boundaries.add(interval.start);
    boundaries.add(interval.end);
  });
  highlightIntervals.forEach((interval) => {
    boundaries.add(interval.start);
    boundaries.add(interval.end);
  });

  const sortedBoundaries = Array.from(boundaries).sort((left, right) => left - right);
  const splitIntervals = [];
  for (let index = 0; index < sortedBoundaries.length - 1; index += 1) {
    const start = sortedBoundaries[index];
    const end = sortedBoundaries[index + 1];
    if (end <= start) continue;
    const inContext = contextIntervals.some(
      (interval) => interval.start < end && interval.end > start,
    );
    if (!inContext) continue;
    splitIntervals.push({
      start,
      end,
      highlighted: highlightIntervals.some(
        (interval) => interval.start < end && interval.end > start,
      ),
    });
  }
  return splitIntervals;
}

function buildHighlightedSentencePreviewHtml(
  articleHtml,
  sentences,
  contextSentences,
  highlightSentences,
) {
  if (
    !articleHtml ||
    !Array.isArray(sentences) ||
    !Array.isArray(contextSentences) ||
    !Array.isArray(highlightSentences)
  ) {
    return '';
  }
  if (sentences.length === 0 || contextSentences.length === 0 || typeof document === 'undefined') {
    return '';
  }

  const container = document.createElement('div');
  container.innerHTML = articleHtml;
  const wordEntries = collectWordEntries([container]);
  const sentenceRanges = buildSentenceWordRanges(sentences, wordEntries);
  const sentenceOffset = [...contextSentences, ...highlightSentences].some(
    (sentenceNumber) => sentenceNumber === 0,
  )
    ? 1
    : 0;
  const contextDomRanges = buildDomRangesForSentences(
    sentenceRanges,
    wordEntries,
    contextSentences,
    sentenceOffset,
  );
  const highlightDomRanges = buildDomRangesForSentences(
    sentenceRanges,
    wordEntries,
    highlightSentences,
    sentenceOffset,
  );

  if (contextDomRanges.length === 0) return '';

  const textNodes = [];
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let textNode;
  while ((textNode = walker.nextNode())) {
    textNodes.push(textNode);
  }

  for (const node of textNodes) {
    const contextIntervals = [];
    const highlightIntervals = [];
    for (const range of contextDomRanges) {
      if (!range.intersectsNode(node)) continue;
      contextIntervals.push({
        start: range.startContainer === node ? range.startOffset : 0,
        end: range.endContainer === node ? range.endOffset : node.nodeValue.length,
      });
    }

    const mergedContextIntervals = preserveWhitespaceGaps(
      mergeIntervals(contextIntervals),
      node.nodeValue,
    );
    if (mergedContextIntervals.length === 0) {
      node.remove();
      continue;
    }

    for (const range of highlightDomRanges) {
      if (!range.intersectsNode(node)) continue;
      highlightIntervals.push({
        start: range.startContainer === node ? range.startOffset : 0,
        end: range.endContainer === node ? range.endOffset : node.nodeValue.length,
      });
    }

    const splitIntervals = splitPreviewIntervals(
      mergedContextIntervals,
      mergeIntervals(highlightIntervals),
    );
    const fragment = document.createDocumentFragment();
    for (const interval of splitIntervals) {
      const text = node.nodeValue.slice(interval.start, interval.end);
      if (!text.trim()) continue;
      if (!interval.highlighted) {
        fragment.appendChild(document.createTextNode(text));
        continue;
      }
      const mark = document.createElement('mark');
      mark.className = 'canvas-summary-source-preview__highlight';
      mark.textContent = text;
      fragment.appendChild(mark);
    }
    node.replaceWith(fragment);
  }

  pruneEmptyElements(container);
  return container.innerHTML;
}

function CanvasSummaryView({
  summaryViewCards,
  summaryViewActivePath,
  summaryViewHoveredPath,
  summaryCardRefs,
  setHoveredTopicKey,
  articleTextRef,
  onShowSourceSentences,
  articleHtml,
  sentences,
  sourceUrl,
  previewWidth,
}) {
  const [lockedPreviewKey, setLockedPreviewKey] = React.useState(null);
  const [hoveredSummaryKey, setHoveredSummaryKey] = React.useState(null);
  const [previewLeft, setPreviewLeft] = React.useState(0);
  const previewRef = React.useRef(null);
  const previewScrollRef = React.useRef(null);
  const summaryViewRef = React.useRef(null);
  const hidePreviewTimerRef = React.useRef(0);
  const summaryCardByKey = React.useMemo(() => {
    const map = new Map();
    summaryViewCards.forEach((card) => {
      map.set(card.key || card.path, card);
    });
    return map;
  }, [summaryViewCards]);
  const activePreviewCard = React.useMemo(() => {
    if (summaryViewHoveredPath) {
      return (
        summaryViewCards.find((card) => card.path === summaryViewHoveredPath) ||
        summaryViewCards.find(
          (card) =>
            card.path.startsWith(`${summaryViewHoveredPath} > `) ||
            summaryViewHoveredPath.startsWith(`${card.path} > `),
        ) ||
        null
      );
    }
    if (hoveredSummaryKey && summaryCardByKey.has(hoveredSummaryKey)) {
      return summaryCardByKey.get(hoveredSummaryKey);
    }
    if (lockedPreviewKey && summaryCardByKey.has(lockedPreviewKey)) {
      return summaryCardByKey.get(lockedPreviewKey);
    }
    if (summaryViewActivePath) {
      return (
        summaryViewCards.find((card) => card.path === summaryViewActivePath) ||
        summaryViewCards.find(
          (card) =>
            card.path.startsWith(`${summaryViewActivePath} > `) ||
            summaryViewActivePath.startsWith(`${card.path} > `),
        ) ||
        null
      );
    }
    return null;
  }, [
    hoveredSummaryKey,
    lockedPreviewKey,
    summaryCardByKey,
    summaryViewActivePath,
    summaryViewHoveredPath,
    summaryViewCards,
  ]);
  const previewCard = activePreviewCard?.sourceSentences?.length ? activePreviewCard : null;
  const previewCardKey = previewCard?.key || previewCard?.path || null;
  const previewSentenceNumbers = React.useMemo(() => {
    if (!previewCard) return [];
    const previewCardIndex = summaryViewCards.findIndex(
      (card) => (card.key || card.path) === previewCardKey,
    );
    const contextCards = [
      summaryViewCards[previewCardIndex - 1],
      previewCard,
      summaryViewCards[previewCardIndex + 1],
    ].filter((card) => Array.isArray(card?.sourceSentences) && card.sourceSentences.length > 0);
    return Array.from(new Set(contextCards.flatMap((card) => card.sourceSentences)));
  }, [previewCard, previewCardKey, summaryViewCards]);
  const previewHtml = React.useMemo(
    () =>
      previewCard
        ? buildHighlightedSentencePreviewHtml(
            articleHtml,
            sentences,
            previewSentenceNumbers,
            previewCard.sourceSentences,
          )
        : '',
    [articleHtml, sentences, previewCard, previewSentenceNumbers],
  );
  const previewTop = summaryCardRefs.current[previewCardKey]?.offsetTop || 0;
  const previewYouTubeLink = React.useMemo(
    () =>
      previewCard
        ? getYouTubeTimestampLink({
            sourceUrl,
            sentences,
            sourceSentences: previewCard.sourceSentences,
          })
        : null,
    [previewCard, sourceUrl, sentences],
  );

  const setSummaryViewRefs = React.useCallback(
    (el) => {
      summaryViewRef.current = el;
      if (articleTextRef && typeof articleTextRef === 'object') {
        articleTextRef.current = el;
      } else if (typeof articleTextRef === 'function') {
        articleTextRef(el);
      }
    },
    [articleTextRef],
  );

  React.useLayoutEffect(() => {
    const el = previewRef.current;
    if (!el) return;
    const measure = () => {
      el.style.setProperty('--summary-source-preview-height', `${el.offsetHeight}px`);
      const summaryEl = summaryViewRef.current;
      if (summaryEl) {
        setPreviewLeft(summaryEl.offsetLeft - el.offsetWidth - 18);
      }
    };
    measure();
    if (typeof window.ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const resizeObserver = new window.ResizeObserver(measure);
    resizeObserver.observe(el);
    if (summaryViewRef.current) resizeObserver.observe(summaryViewRef.current);
    return () => resizeObserver.disconnect();
  }, [previewCard, previewHtml, previewTop, previewWidth]);

  React.useLayoutEffect(() => {
    const scrollEl = previewScrollRef.current;
    if (!scrollEl) return;
    const highlightedSentence = scrollEl.querySelector('.canvas-summary-source-preview__highlight');
    if (!highlightedSentence) {
      scrollEl.scrollTop = 0;
      return;
    }
    const scrollRect = scrollEl.getBoundingClientRect();
    const highlightRect = highlightedSentence.getBoundingClientRect();
    const highlightTop = scrollEl.scrollTop + highlightRect.top - scrollRect.top;
    scrollEl.scrollTop = Math.max(0, highlightTop - 48);
  }, [previewCardKey, previewHtml]);

  const clearHidePreviewTimer = React.useCallback(() => {
    window.clearTimeout(hidePreviewTimerRef.current);
    hidePreviewTimerRef.current = 0;
  }, []);

  const showPreviewForCard = React.useCallback(
    (card) => {
      clearHidePreviewTimer();
      if (card.sourceSentences.length > 0) {
        setHoveredSummaryKey(card.key || card.path);
      }
    },
    [clearHidePreviewTimer],
  );

  const schedulePreviewHide = React.useCallback(
    (card) => {
      if (lockedPreviewKey === (card.key || card.path)) return;
      clearHidePreviewTimer();
      hidePreviewTimerRef.current = window.setTimeout(() => {
        setHoveredSummaryKey((current) => (current === (card.key || card.path) ? null : current));
      }, SENTENCE_PREVIEW_HIDE_DELAY_MS);
    },
    [clearHidePreviewTimer, lockedPreviewKey],
  );

  React.useEffect(
    () => () => {
      window.clearTimeout(hidePreviewTimerRef.current);
    },
    [],
  );

  if (summaryViewCards.length === 0) {
    return (
      <div className="canvas-summary-view" ref={articleTextRef}>
        <p className="canvas-summary-view__empty">No summaries available at this level.</p>
      </div>
    );
  }

  return (
    <>
      {previewCard && previewHtml && (
        <aside
          ref={previewRef}
          id="canvas-summary-source-preview"
          className="canvas-summary-source-preview"
          aria-label="Source sentence preview"
          style={{
            position: 'absolute',
            left: previewLeft,
            top: previewTop,
            '--summary-source-preview-left': `${previewLeft}px`,
            '--summary-source-preview-top': `${previewTop}px`,
          }}
          onMouseDown={(event) => event.stopPropagation()}
          onMouseEnter={clearHidePreviewTimer}
          onMouseLeave={() => {
            if (!lockedPreviewKey) {
              clearHidePreviewTimer();
              setHoveredSummaryKey(null);
            }
          }}
          onTouchStart={(event) => event.stopPropagation()}
          onWheel={(event) => event.stopPropagation()}
          onWheelCapture={(event) => event.stopPropagation()}
        >
          <article ref={previewScrollRef} className="canvas-summary-source-preview__card">
            <header className="canvas-summary-view__card-header canvas-summary-view__card-header--stacked">
              <div className="canvas-summary-view__card-title-block">
                <span className="canvas-summary-view__card-kicker">Source</span>
                <span className="canvas-summary-view__card-path">{previewCard.path}</span>
              </div>
              <YouTubeTimestampButton link={previewYouTubeLink} />
            </header>
            <div
              className="canvas-summary-source-preview__article pagetollm-article-html"
              dangerouslySetInnerHTML={{ __html: previewHtml }}
            />
          </article>
        </aside>
      )}
      <div className="canvas-summary-view" ref={setSummaryViewRefs}>
        <div className="canvas-summary-view__cards">
          {summaryViewCards.map((card) => {
            const isActive = summaryViewActivePath === card.path;
            const hasSummaryContent = Boolean(card.text);
            const canShowSourceSentences = card.sourceSentences.length > 0;
            const isPreviewActive = previewCardKey === (card.key || card.path);
            return (
              <article
                key={card.key || card.path}
                ref={(el) => {
                  if (el) summaryCardRefs.current[card.key || card.path] = el;
                  else delete summaryCardRefs.current[card.key || card.path];
                }}
                className={`canvas-summary-view__card${isActive ? ' is-active' : ''}${isPreviewActive ? ' is-source-preview-active' : ''}`}
                onMouseEnter={() => {
                  setHoveredTopicKey(card.path);
                  showPreviewForCard(card);
                }}
                onMouseLeave={() => {
                  setHoveredTopicKey((current) => (current === card.path ? null : current));
                  schedulePreviewHide(card);
                }}
                onClick={() => {
                  if (!canShowSourceSentences) return;
                  setLockedPreviewKey((current) => {
                    const key = card.key || card.path;
                    if (current === key) {
                      setHoveredSummaryKey(null);
                      return null;
                    }
                    showPreviewForCard(card);
                    return key;
                  });
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Escape' && lockedPreviewKey) {
                    event.stopPropagation();
                    setLockedPreviewKey(null);
                    setHoveredSummaryKey(null);
                  }
                }}
                tabIndex={0}
                aria-expanded={canShowSourceSentences ? isPreviewActive : undefined}
                aria-controls={isPreviewActive ? 'canvas-summary-source-preview' : undefined}
                title={card.path}
              >
                <header className="canvas-summary-view__card-header">
                  <span className="canvas-summary-view__card-path">{card.path}</span>
                  {card.sourceSentences.length > 0 && (
                    <span className="canvas-summary-view__card-meta">
                      sentences {card.startSentence} ({card.sourceSentences.length})
                    </span>
                  )}
                </header>
                {hasSummaryContent && (
                  <div className="canvas-summary-view__summary-tooltip-wrap">
                    {card.text && <p className="canvas-summary-view__card-text">{card.text}</p>}
                    {canShowSourceSentences && (
                      <div className="canvas-summary-view__summary-tooltip" role="tooltip">
                        <button
                          type="button"
                          className="canvas-summary-view__summary-tooltip-button"
                          onMouseDown={(event) => event.stopPropagation()}
                          onClick={(event) => {
                            event.stopPropagation();
                            onShowSourceSentences(card);
                          }}
                        >
                          Show source sentences
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </div>
    </>
  );
}

export default React.memo(CanvasSummaryView);
