import React from 'react';
import { collectWordEntries, buildSentenceWordRanges } from '../sentenceHighlight.js';
import { getYouTubeTimestampLink } from '../utils/youtubeTimestamp.js';
import YouTubeTimestampButton from './YouTubeTimestampButton.jsx';

const SENTENCE_PREVIEW_HIDE_DELAY_MS = 120;
// Small delay before a hovered card opens its source preview. Without it, sweeping
// the cursor across the column rebuilds the (expensive) preview HTML for every card
// crossed; the delay collapses a fast sweep into a single build once hover settles.
const SENTENCE_PREVIEW_SHOW_DELAY_MS = 90;

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
  // Reverse document order is bottom-up: a parent is visited only after its
  // descendants, so a single pass handles cascading emptiness (a parent left
  // empty by removed children is itself empty by the time we reach it). This
  // replaces a previous while(changed) loop that re-scanned the whole tree.
  Array.from(root.querySelectorAll('*'))
    .reverse()
    .forEach((el) => {
      if (keepEmptyTags.has(el.tagName)) return;
      if (el.textContent.trim() === '' && el.querySelector('img, video, audio, iframe') === null) {
        el.remove();
      }
    });
}

function normalizeSentenceNumbers(sourceSentences, sentenceOffset) {
  return sourceSentences.map((sentenceNumber) => sentenceNumber + sentenceOffset);
}

function collectTextNodes(root) {
  const textNodes = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let textNode;
  while ((textNode = walker.nextNode())) {
    textNodes.push(textNode);
  }
  return textNodes;
}

function buildPreviewSourceModel(articleHtml, sentences) {
  if (!articleHtml || !Array.isArray(sentences) || sentences.length === 0) {
    return null;
  }
  if (typeof document === 'undefined') {
    return null;
  }

  const container = document.createElement('div');
  container.innerHTML = articleHtml;
  const wordEntries = collectWordEntries([container]);
  const sentenceRanges = buildSentenceWordRanges(sentences, wordEntries);
  const textNodes = collectTextNodes(container);
  const textNodeIndexByNode = new Map(textNodes.map((node, index) => [node, index]));
  const sentenceIntervalsByNumber = new Map();

  for (const [sentenceNumber, wordRange] of sentenceRanges) {
    const startEntry = wordEntries[wordRange.startIdx];
    const endEntry = wordEntries[wordRange.endIdx];
    if (!startEntry || !endEntry) continue;

    const startNodeIndex = textNodeIndexByNode.get(startEntry.node);
    const endNodeIndex = textNodeIndexByNode.get(endEntry.node);
    if (startNodeIndex === undefined || endNodeIndex === undefined) continue;

    const intervals = [];
    for (let nodeIndex = startNodeIndex; nodeIndex <= endNodeIndex; nodeIndex += 1) {
      const node = textNodes[nodeIndex];
      intervals.push({
        nodeIndex,
        start: nodeIndex === startNodeIndex ? startEntry.start : 0,
        end: nodeIndex === endNodeIndex ? endEntry.end : node.nodeValue.length,
      });
    }
    sentenceIntervalsByNumber.set(sentenceNumber, intervals);
  }

  return {
    container,
    sentenceIntervalsByNumber,
  };
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

function getPreviewIntervals(sourceModel, sourceSentences, sentenceOffset) {
  return normalizeSentenceNumbers(sourceSentences, sentenceOffset).flatMap(
    (sentenceNumber) => sourceModel.sentenceIntervalsByNumber.get(sentenceNumber) || [],
  );
}

function buildHighlightedSentencePreviewHtml(sourceModel, contextSentences, highlightSentences) {
  if (!sourceModel || !Array.isArray(contextSentences) || !Array.isArray(highlightSentences)) {
    return '';
  }
  if (contextSentences.length === 0 || typeof document === 'undefined') {
    return '';
  }

  const sentenceOffset = [...contextSentences, ...highlightSentences].some(
    (sentenceNumber) => sentenceNumber === 0,
  )
    ? 1
    : 0;

  const contextIntervalsByNode = new Map();
  const highlightIntervalsByNode = new Map();
  getPreviewIntervals(sourceModel, contextSentences, sentenceOffset).forEach((interval) => {
    const nodeIntervals = contextIntervalsByNode.get(interval.nodeIndex) || [];
    nodeIntervals.push(interval);
    contextIntervalsByNode.set(interval.nodeIndex, nodeIntervals);
  });
  if (contextIntervalsByNode.size === 0) return '';

  getPreviewIntervals(sourceModel, highlightSentences, sentenceOffset).forEach((interval) => {
    const nodeIntervals = highlightIntervalsByNode.get(interval.nodeIndex) || [];
    nodeIntervals.push(interval);
    highlightIntervalsByNode.set(interval.nodeIndex, nodeIntervals);
  });

  const container = sourceModel.container.cloneNode(true);
  const textNodes = collectTextNodes(container);

  textNodes.forEach((node, nodeIndex) => {
    const mergedContextIntervals = preserveWhitespaceGaps(
      mergeIntervals(contextIntervalsByNode.get(nodeIndex) || []),
      node.nodeValue,
    );
    if (mergedContextIntervals.length === 0) {
      node.remove();
      return;
    }

    const splitIntervals = splitPreviewIntervals(
      mergedContextIntervals,
      mergeIntervals(highlightIntervalsByNode.get(nodeIndex) || []),
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
  });

  pruneEmptyElements(container);
  return container.innerHTML;
}

const previewHtmlCache = new Map();

// The source model is keyed on its inputs so the per-render memo below returns a
// stable identity across hover toggles (which flip the memo's `hasActivePreview`
// dep without changing the content). Without this, every cursor enter/leave would
// rebuild the whole article index and wipe previewHtmlCache.
let sourceModelCache = { articleHtml: null, sentences: null, model: null };
function getOrBuildPreviewSourceModel(articleHtml, sentences) {
  if (sourceModelCache.articleHtml === articleHtml && sourceModelCache.sentences === sentences) {
    return sourceModelCache.model;
  }
  const model = buildPreviewSourceModel(articleHtml, sentences);
  sourceModelCache = { articleHtml, sentences, model };
  return model;
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
  const showPreviewTimerRef = React.useRef(0);
  const summaryCardByKey = React.useMemo(() => {
    const map = new Map();
    summaryViewCards.forEach((card) => {
      map.set(card.key || card.path, card);
    });
    return map;
  }, [summaryViewCards]);
  const summaryCardByPath = React.useMemo(() => {
    const map = new Map();
    summaryViewCards.forEach((card) => {
      map.set(card.path, card);
    });
    return map;
  }, [summaryViewCards]);
  const findCardByPath = React.useCallback(
    (path) => {
      if (summaryCardByPath.has(path)) return summaryCardByPath.get(path);
      return (
        summaryViewCards.find(
          (card) => card.path.startsWith(`${path} > `) || path.startsWith(`${card.path} > `),
        ) || null
      );
    },
    [summaryCardByPath, summaryViewCards],
  );
  const activePreviewCard = React.useMemo(() => {
    if (summaryViewHoveredPath) return findCardByPath(summaryViewHoveredPath);
    if (hoveredSummaryKey && summaryCardByKey.has(hoveredSummaryKey)) {
      return summaryCardByKey.get(hoveredSummaryKey);
    }
    if (lockedPreviewKey && summaryCardByKey.has(lockedPreviewKey)) {
      return summaryCardByKey.get(lockedPreviewKey);
    }
    if (summaryViewActivePath) return findCardByPath(summaryViewActivePath);
    return null;
  }, [
    findCardByPath,
    hoveredSummaryKey,
    lockedPreviewKey,
    summaryCardByKey,
    summaryViewActivePath,
    summaryViewHoveredPath,
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
  // Indexing the whole article (clone + word/sentence ranges) is the heaviest
  // step in this view and is needed only once a source preview is shown. Gate
  // the build behind `previewModelReady` so summary-mode entry isn't blocked by
  // an eager build: the flag flips either when a preview is first needed or
  // during idle shortly after mount (whichever comes first), so the first hover
  // still finds the model ready. Once flipped it stays on; the useMemo below
  // rebuilds only when the source content actually changes.
  const [previewModelReady, setPreviewModelReady] = React.useState(false);
  // Warm the (lazy) source-model build during idle time after mount so the first
  // hover finds it ready without blocking summary-mode entry.
  React.useEffect(() => {
    if (previewModelReady || !articleHtml || !Array.isArray(sentences) || sentences.length === 0) {
      return undefined;
    }
    let cancelled = false;
    const activate = () => {
      if (!cancelled) setPreviewModelReady(true);
    };
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(activate, { timeout: 200 });
      return () => {
        cancelled = true;
        window.cancelIdleCallback?.(id);
      };
    }
    const id = window.setTimeout(activate, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
  }, [previewModelReady, articleHtml, sentences]);
  // Build when warmed, or immediately if a preview is needed before the idle
  // warm-up fires. The boolean (not previewCard itself) keeps the memo stable
  // across different hovers so the heavy index isn't rebuilt per card.
  const hasActivePreview = Boolean(previewCard);
  const previewSourceModel = React.useMemo(
    () =>
      (previewModelReady || hasActivePreview) &&
      articleHtml &&
      Array.isArray(sentences) &&
      sentences.length > 0
        ? getOrBuildPreviewSourceModel(articleHtml, sentences)
        : null,
    [previewModelReady, hasActivePreview, articleHtml, sentences],
  );
  // The per-preview HTML cache is invalidated when the source model or the card
  // set changes.
  React.useEffect(() => {
    previewHtmlCache.clear();
  }, [previewSourceModel, summaryViewCards]);
  const previewHtml = React.useMemo(() => {
    if (!previewCard || !previewSourceModel) return '';
    const cacheKey = [
      previewCardKey,
      previewSentenceNumbers.join(','),
      previewCard.sourceSentences.join(','),
    ].join('|');
    const cachedHtml = previewHtmlCache.get(cacheKey);
    if (cachedHtml !== undefined) return cachedHtml;

    const html = buildHighlightedSentencePreviewHtml(
      previewSourceModel,
      previewSentenceNumbers,
      previewCard.sourceSentences,
    );
    previewHtmlCache.set(cacheKey, html);
    return html;
  }, [previewCard, previewCardKey, previewSentenceNumbers, previewSourceModel]);
  const previewTop = summaryCardRefs.current[previewCardKey]?.offsetTop || 0;
  // Resolving a YouTube deep-link scans the sentence array; doing it per card
  // inside the render map re-ran it for every card on every hover/zoom. Compute
  // the whole set once and reuse it for both the cards and the preview header.
  const youTubeLinkByKey = React.useMemo(() => {
    const map = new Map();
    summaryViewCards.forEach((card) => {
      map.set(
        card.key || card.path,
        getYouTubeTimestampLink({ sourceUrl, sentences, sourceSentences: card.sourceSentences }),
      );
    });
    return map;
  }, [summaryViewCards, sourceUrl, sentences]);
  const previewYouTubeLink = previewCardKey ? youTubeLinkByKey.get(previewCardKey) || null : null;

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

  const clearShowPreviewTimer = React.useCallback(() => {
    window.clearTimeout(showPreviewTimerRef.current);
    showPreviewTimerRef.current = 0;
  }, []);

  const showPreviewForCard = React.useCallback(
    (card, { immediate = false } = {}) => {
      clearHidePreviewTimer();
      clearShowPreviewTimer();
      const key = card.key || card.path;
      const hasSource = card.sourceSentences.length > 0;
      // Defer BOTH the parent hovered-topic key and the local preview key. The
      // topic key must go through the same timer rather than being set eagerly in
      // onMouseEnter: activePreviewCard prioritizes summaryViewHoveredPath (driven
      // by that parent key), so setting it immediately would rebuild the expensive
      // preview HTML before this debounce fires — defeating it for every card
      // crossed during a fast sweep. Rail hovers still set the topic key directly
      // in the parent, so that path stays immediate.
      const apply = () => {
        setHoveredTopicKey(card.path);
        if (hasSource) setHoveredSummaryKey(key);
      };
      if (immediate) {
        apply();
        return;
      }
      showPreviewTimerRef.current = window.setTimeout(apply, SENTENCE_PREVIEW_SHOW_DELAY_MS);
    },
    [clearHidePreviewTimer, clearShowPreviewTimer, setHoveredTopicKey],
  );

  const schedulePreviewHide = React.useCallback(
    (card) => {
      // A pending open should not survive the cursor leaving the card.
      clearShowPreviewTimer();
      if (lockedPreviewKey === (card.key || card.path)) return;
      clearHidePreviewTimer();
      hidePreviewTimerRef.current = window.setTimeout(() => {
        setHoveredSummaryKey((current) => (current === (card.key || card.path) ? null : current));
      }, SENTENCE_PREVIEW_HIDE_DELAY_MS);
    },
    [clearHidePreviewTimer, clearShowPreviewTimer, lockedPreviewKey],
  );

  React.useEffect(
    () => () => {
      window.clearTimeout(hidePreviewTimerRef.current);
      window.clearTimeout(showPreviewTimerRef.current);
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
            const cardYouTubeLink = youTubeLinkByKey.get(card.key || card.path) || null;
            const isPreviewActive = previewCardKey === (card.key || card.path);
            return (
              <article
                key={card.key || card.path}
                ref={(el) => {
                  if (el) summaryCardRefs.current[card.key || card.path] = el;
                  else delete summaryCardRefs.current[card.key || card.path];
                }}
                className={`canvas-summary-view__card${isActive ? ' is-active' : ''}${isPreviewActive ? ' is-source-preview-active' : ''}`}
                onMouseEnter={() => showPreviewForCard(card)}
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
                    showPreviewForCard(card, { immediate: true });
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
                    {(canShowSourceSentences || cardYouTubeLink) && (
                      <div className="canvas-summary-view__summary-tooltip" role="tooltip">
                        {canShowSourceSentences && (
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
                        )}
                        <YouTubeTimestampButton link={cardYouTubeLink} />
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
