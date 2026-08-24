import React from 'react';
import { getYouTubeTimestampLink, getYouTubeVideoId } from '../../utils/youtubeTimestamp.js';
import YouTubeTimestampButton from '../../components/YouTubeTimestampButton.jsx';
import {
  buildHighlightedSentencePreviewHtml,
  buildPreviewSourceModel,
} from './CanvasSummaryView.preview.js';

const SENTENCE_PREVIEW_HIDE_DELAY_MS = 120;
// Small delay before a hovered card opens its source preview. Without it, sweeping
// the cursor across the column rebuilds the (expensive) preview HTML for every card
// crossed; the delay collapses a fast sweep into a single build once hover settles.
const SENTENCE_PREVIEW_SHOW_DELAY_MS = 90;
const PREVIEW_HTML_CACHE_LIMIT = 80;

// Per-instance caches, keyed by a Symbol minted in state (see
// `previewCacheInstanceKey` below) rather than a `useRef`: this project's lint
// config (react-hooks/refs, aligned with the React Compiler) disallows reading
// `.current` during render through anything but a direct, un-passed access, so a
// mutable cache that's read/written from inside a `useMemo` can't be ref-backed.
// Keying a module-level Map by an instance id gets the same per-instance
// isolation (no cross-instance cache thrashing) without touching a ref during
// render; the entry is deleted on unmount below so it doesn't leak.
const previewHtmlCacheByInstance = new Map();
const sourceModelCacheByInstance = new Map();

function getOrBuildPreviewSourceModel(instanceKey, articleHtml, sentences) {
  const cached = sourceModelCacheByInstance.get(instanceKey);
  if (cached?.articleHtml === articleHtml && cached.sentences === sentences) {
    return cached.model;
  }
  const model = buildPreviewSourceModel(articleHtml, sentences);
  sourceModelCacheByInstance.set(instanceKey, { articleHtml, sentences, model });
  return model;
}

function getPreviewHtmlCache(instanceKey, previewSourceModel, summaryViewCards) {
  const cached = previewHtmlCacheByInstance.get(instanceKey);
  if (cached?.sourceModel === previewSourceModel && cached.summaryViewCards === summaryViewCards) {
    return cached.cache;
  }
  const next = { sourceModel: previewSourceModel, summaryViewCards, cache: new Map() };
  previewHtmlCacheByInstance.set(instanceKey, next);
  return next.cache;
}

function setSummaryCardRef(summaryCardRefs, cardKey, el) {
  if (el) summaryCardRefs.current[cardKey] = el;
  else delete summaryCardRefs.current[cardKey];
}

const SummaryCard = React.memo(function SummaryCard({
  card,
  cardKey,
  registerSummaryCardRef,
  isCardActive,
  isPreviewActive,
  cardYouTubeLink,
  onCardEnter,
  onCardLeave,
  onCardClick,
  onCardKeyDown,
  onShowSourceSentences,
}) {
  const hasSummaryContent = Boolean(card.text);
  const canShowSourceSentences = card.sourceSentences.length > 0;
  const cardRef = React.useCallback(
    (el) => {
      registerSummaryCardRef(cardKey, el);
    },
    [cardKey, registerSummaryCardRef],
  );

  return (
    <article
      ref={cardRef}
      className={`canvas-summary-view__card${isCardActive ? ' is-active' : ''}${isPreviewActive ? ' is-source-preview-active' : ''}`}
      onMouseEnter={() => onCardEnter(card)}
      onMouseLeave={() => onCardLeave(card)}
      onClick={() => onCardClick(card)}
      onKeyDown={onCardKeyDown}
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
});

function CanvasSummaryView({
  summaryViewCards,
  summaryViewActivePath,
  summaryViewActiveCardKey,
  summaryViewHoveredPath,
  summaryViewHoveredCardKey,
  summaryCardRefs,
  setHoveredTopicKey,
  setHoveredTopicCardKey,
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
  const lockedPreviewKeyRef = React.useRef(null);
  const [previewCacheInstanceKey] = React.useState(() => Symbol('CanvasSummaryView'));
  React.useLayoutEffect(() => {
    lockedPreviewKeyRef.current = lockedPreviewKey;
  }, [lockedPreviewKey]);
  React.useEffect(
    () => () => {
      previewHtmlCacheByInstance.delete(previewCacheInstanceKey);
      sourceModelCacheByInstance.delete(previewCacheInstanceKey);
    },
    [previewCacheInstanceKey],
  );
  const summaryCardByKey = React.useMemo(() => {
    const map = new Map();
    summaryViewCards.forEach((card) => {
      map.set(card.key, card);
    });
    return map;
  }, [summaryViewCards]);
  const summaryCardIndexByKey = React.useMemo(() => {
    const map = new Map();
    summaryViewCards.forEach((card, index) => {
      map.set(card.key, index);
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
  const hasActiveSummaryCardKey = Boolean(
    summaryViewActiveCardKey && summaryCardByKey.has(summaryViewActiveCardKey),
  );
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
    if (summaryViewHoveredCardKey && summaryCardByKey.has(summaryViewHoveredCardKey)) {
      return summaryCardByKey.get(summaryViewHoveredCardKey);
    }
    if (summaryViewHoveredPath) return findCardByPath(summaryViewHoveredPath);
    if (hoveredSummaryKey && summaryCardByKey.has(hoveredSummaryKey)) {
      return summaryCardByKey.get(hoveredSummaryKey);
    }
    if (lockedPreviewKey && summaryCardByKey.has(lockedPreviewKey)) {
      return summaryCardByKey.get(lockedPreviewKey);
    }
    if (summaryViewActiveCardKey && summaryCardByKey.has(summaryViewActiveCardKey)) {
      return summaryCardByKey.get(summaryViewActiveCardKey);
    }
    if (summaryViewActivePath) return findCardByPath(summaryViewActivePath);
    return null;
  }, [
    findCardByPath,
    hoveredSummaryKey,
    lockedPreviewKey,
    summaryCardByKey,
    summaryViewActiveCardKey,
    summaryViewActivePath,
    summaryViewHoveredCardKey,
    summaryViewHoveredPath,
  ]);
  const previewCard = activePreviewCard?.sourceSentences?.length ? activePreviewCard : null;
  const previewCardKey = previewCard?.key || previewCard?.path || null;
  const previewSentenceNumbers = React.useMemo(() => {
    if (!previewCard) return [];
    const previewCardIndex = summaryCardIndexByKey.get(previewCardKey) ?? -1;
    const contextCards = [
      summaryViewCards[previewCardIndex - 1],
      previewCard,
      summaryViewCards[previewCardIndex + 1],
    ].filter((card) => Array.isArray(card?.sourceSentences) && card.sourceSentences.length > 0);
    return Array.from(new Set(contextCards.flatMap((card) => card.sourceSentences)));
  }, [previewCard, previewCardKey, summaryCardIndexByKey, summaryViewCards]);
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
        ? getOrBuildPreviewSourceModel(previewCacheInstanceKey, articleHtml, sentences)
        : null,
    [previewModelReady, hasActivePreview, articleHtml, sentences, previewCacheInstanceKey],
  );
  const previewHtml = React.useMemo(() => {
    if (!previewCard || !previewSourceModel) return '';
    const cache = getPreviewHtmlCache(
      previewCacheInstanceKey,
      previewSourceModel,
      summaryViewCards,
    );
    const cacheKey = [
      previewCardKey,
      previewSentenceNumbers.join(','),
      previewCard.sourceSentences.join(','),
    ].join('|');
    const cachedHtml = cache.get(cacheKey);
    if (cachedHtml !== undefined) {
      cache.delete(cacheKey);
      cache.set(cacheKey, cachedHtml);
      return cachedHtml;
    }

    const html = buildHighlightedSentencePreviewHtml(
      previewSourceModel,
      previewSentenceNumbers,
      previewCard.sourceSentences,
    );
    if (cache.size >= PREVIEW_HTML_CACHE_LIMIT) {
      const oldestKey = cache.keys().next().value;
      cache.delete(oldestKey);
    }
    cache.set(cacheKey, html);
    return html;
  }, [
    previewCacheInstanceKey,
    previewCard,
    previewCardKey,
    previewSentenceNumbers,
    previewSourceModel,
    summaryViewCards,
  ]);
  const previewTop = summaryCardRefs.current[previewCardKey]?.offsetTop || 0;
  const isYouTube = React.useMemo(() => Boolean(getYouTubeVideoId(sourceUrl)), [sourceUrl]);
  // Resolving a YouTube deep-link scans the sentence array; doing it per card
  // inside the render map re-ran it for every card on every hover/zoom. Compute
  // the whole set once and reuse it for both the cards and the preview header.
  const youTubeLinkByKey = React.useMemo(() => {
    const map = new Map();
    if (!isYouTube) return map;
    summaryViewCards.forEach((card) => {
      map.set(
        card.key,
        getYouTubeTimestampLink({ sourceUrl, sentences, sourceSentences: card.sourceSentences }),
      );
    });
    return map;
  }, [isYouTube, summaryViewCards, sourceUrl, sentences]);
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
  const registerSummaryCardRef = React.useCallback(
    (cardKey, el) => {
      setSummaryCardRef(summaryCardRefs, cardKey, el);
    },
    [summaryCardRefs],
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
      const key = card.key;
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
        setHoveredTopicCardKey?.(key);
        if (hasSource) setHoveredSummaryKey(key);
      };
      if (immediate) {
        apply();
        return;
      }
      showPreviewTimerRef.current = window.setTimeout(apply, SENTENCE_PREVIEW_SHOW_DELAY_MS);
    },
    [clearHidePreviewTimer, clearShowPreviewTimer, setHoveredTopicCardKey, setHoveredTopicKey],
  );

  const schedulePreviewHide = React.useCallback(
    (card) => {
      // A pending open should not survive the cursor leaving the card.
      clearShowPreviewTimer();
      if (lockedPreviewKeyRef.current === card.key) return;
      clearHidePreviewTimer();
      hidePreviewTimerRef.current = window.setTimeout(() => {
        setHoveredSummaryKey((current) => (current === card.key ? null : current));
      }, SENTENCE_PREVIEW_HIDE_DELAY_MS);
    },
    [clearHidePreviewTimer, clearShowPreviewTimer],
  );

  const handleSummaryCardLeave = React.useCallback(
    (card) => {
      const cardKey = card.key;
      setHoveredTopicKey((current) => (current === card.path ? null : current));
      setHoveredTopicCardKey?.((current) => (current === cardKey ? null : current));
      schedulePreviewHide(card);
    },
    [schedulePreviewHide, setHoveredTopicCardKey, setHoveredTopicKey],
  );

  const handleSummaryCardClick = React.useCallback(
    (card) => {
      if (card.sourceSentences.length === 0) return;
      const cardKey = card.key;
      setLockedPreviewKey((current) => {
        if (current === cardKey) {
          setHoveredSummaryKey(null);
          return null;
        }
        showPreviewForCard(card, { immediate: true });
        return cardKey;
      });
    },
    [showPreviewForCard],
  );

  const handleSummaryCardKeyDown = React.useCallback((event) => {
    if (event.key === 'Escape' && lockedPreviewKeyRef.current) {
      event.stopPropagation();
      setLockedPreviewKey(null);
      setHoveredSummaryKey(null);
    }
  }, []);

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
            const cardKey = card.key;
            const isCardActive = hasActiveSummaryCardKey
              ? summaryViewActiveCardKey === cardKey
              : isActive;
            const cardYouTubeLink = youTubeLinkByKey.get(cardKey) || null;
            const isPreviewActive = previewCardKey === cardKey;
            return (
              <SummaryCard
                key={cardKey}
                card={card}
                cardKey={cardKey}
                registerSummaryCardRef={registerSummaryCardRef}
                isCardActive={isCardActive}
                isPreviewActive={isPreviewActive}
                cardYouTubeLink={cardYouTubeLink}
                onCardEnter={showPreviewForCard}
                onCardLeave={handleSummaryCardLeave}
                onCardClick={handleSummaryCardClick}
                onCardKeyDown={handleSummaryCardKeyDown}
                onShowSourceSentences={onShowSourceSentences}
              />
            );
          })}
        </div>
      </div>
    </>
  );
}

export default React.memo(CanvasSummaryView);
