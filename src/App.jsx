import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRecord } from "./useRecord.js";
import {
  buildTopicCards,
  getMaxTopicLevel,
  getTopicSentenceNumbers,
  getTopicTitleFontSize,
  getZoomAdjustedCardWidth,
  splitTopicPath,
  COLUMN_GAP,
  RAIL_PADDING,
} from "./topicCards.js";

/** Normalize a raw topic.name ("A>B>C") to the rail's canonical form ("A > B > C"). */
function normalizeTopicPath(name) {
  return splitTopicPath(name).join(" > ");
}
import { buildSummaryCards } from "./summaryCards.js";
import CanvasTopicHierarchyRail from "./components/CanvasTopicHierarchyRail.jsx";
import CanvasSummaryView from "./components/CanvasSummaryView.jsx";
import CanvasZoomControls from "./components/CanvasZoomControls.jsx";
import { useCanvasTransform, clampScale } from "./useCanvasTransform.js";

function closeModal() {
  try {
    window.parent.postMessage({ type: "pagetollm-close" }, "*");
  } catch (_) {
    /* noop */
  }
}

/**
 * @param {{
 *   stage?: string,
 *   error?: string | null,
 *   recordError?: string | null,
 *   onRetry?: () => void,
 *   isMissing?: boolean,
 *   isDeleted?: boolean,
 * }} props
 */
function SpinnerOverlay({ stage, error, recordError, onRetry, isMissing, isDeleted }) {
  if (isMissing) {
    return (
      <div className="pagetollm-spinner-overlay" role="alert">
        <div className="pagetollm-spinner-box">
          <div className="pagetollm-spinner-error-title">Article Not Found</div>
          <div className="pagetollm-spinner-error-body">
            This article could not be found. It may not have been submitted yet.
          </div>
          <div className="pagetollm-spinner-actions">
            <button className="pagetollm-spinner-close-btn" onClick={closeModal}>
              Close
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (isDeleted) {
    return (
      <div className="pagetollm-spinner-overlay" role="alert">
        <div className="pagetollm-spinner-box">
          <div className="pagetollm-spinner-error-title">Article Deleted</div>
          <div className="pagetollm-spinner-error-body">
            This article was deleted while the canvas was open.
          </div>
          <div className="pagetollm-spinner-actions">
            <button className="pagetollm-spinner-close-btn" onClick={closeModal}>
              Close
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (recordError !== undefined) {
    return (
      <div className="pagetollm-spinner-overlay" role="alert">
        <div className="pagetollm-spinner-box">
          <div className="pagetollm-spinner-error-title">Processing Failed</div>
          {recordError && (
            <div className="pagetollm-spinner-error-body">{recordError}</div>
          )}
          <div className="pagetollm-spinner-actions">
            {onRetry && (
              <button className="pagetollm-spinner-retry-btn" onClick={onRetry}>
                Retry
              </button>
            )}
            <button className="pagetollm-spinner-close-btn" onClick={closeModal}>
              Close
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="pagetollm-spinner-overlay" role="alert">
        <div className="pagetollm-spinner-box">
          <div className="pagetollm-spinner-error-title">Error</div>
          <div className="pagetollm-spinner-error-body">{error}</div>
          <div className="pagetollm-spinner-actions">
            <button className="pagetollm-spinner-close-btn" onClick={closeModal}>
              Close
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="pagetollm-spinner-overlay" role="status" aria-live="polite">
      <div className="pagetollm-spinner-box">
        <div className="pagetollm-spinner" />
        <div className="pagetollm-spinner-stage">
          {stage || "Processing..."}
        </div>
      </div>
    </div>
  );
}

/**
 * Article text rendered as a single block of sentence spans.
 * Sentence elements carry `data-sentence-index` so positions can be measured
 * for the topic-hierarchy rail and for zoom-to-target.
 */
function ArticleText({
  sentences,
  topics,
  hoveredTopicKey,
  selectedTopicKey,
  articleTextRef,
}) {
  const sentenceTopics = useMemo(() => {
    const map = new Map();
    for (const t of topics) {
      const path = normalizeTopicPath(t.name);
      for (const idx of getTopicSentenceNumbers(t)) {
        if (!map.has(idx)) map.set(idx, []);
        map.get(idx).push(path);
      }
    }
    return map;
  }, [topics]);

  return (
    <div className="pagetollm-article-text" ref={articleTextRef}>
      <p className="pagetollm-text-block">
        {sentences.map((text, i) => {
          const oneBased = i + 1;
          const sentTopics = sentenceTopics.get(oneBased) || [];
          const isInHovered =
            hoveredTopicKey &&
            sentTopics.some(
              (name) =>
                name === hoveredTopicKey ||
                name.startsWith(hoveredTopicKey + " > "),
            );
          const isInSelected =
            selectedTopicKey &&
            sentTopics.some(
              (name) =>
                name === selectedTopicKey ||
                name.startsWith(selectedTopicKey + " > "),
            );
          const cls = [
            "pagetollm-sentence",
            isInHovered ? "is-hover-topic" : "",
            isInSelected ? "is-selected-topic" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <span
              key={i}
              className={cls}
              data-sentence-index={oneBased}
              title={sentTopics.join(" | ")}
            >
              {i > 0 ? " " : ""}
              {text}
            </span>
          );
        })}
      </p>
    </div>
  );
}

/**
 * @param {{ initialKey: string }} props
 * @returns {import("react").JSX.Element}
 */
export default function App({ initialKey }) {
  const { record, error } = useRecord(initialKey);
  const [showSummaryMode, setShowSummaryMode] = useState(false);
  const [showTopicHierarchy, setShowTopicHierarchy] = useState(true);
  const [selectedTopicKey, setSelectedTopicKey] = useState(null);
  const [hoveredTopicKey, setHoveredTopicKey] = useState(null);
  const [selectedLevel, setSelectedLevel] = useState(0);
  const [sentenceMetrics, setSentenceMetrics] = useState(() => new Map());
  const [pendingZoomSentence, setPendingZoomSentence] = useState(null);

  const articleTextRef = useRef(null);
  const summaryWrapRef = useRef(null);
  const summaryCardRefs = useRef({});

  const {
    translate,
    scale,
    isCanvasDragging,
    isFocusingHighlight,
    canvasWrapRef,
    canvasViewportRef,
    canvasWrapElRef,
    scaleRef,
    translateRef,
    handleMouseDown,
    setTransformNow,
    navigateCanvas,
    zoomToTarget,
  } = useCanvasTransform({ contentRef: articleTextRef });

  const handleCanvasMouseDown = useCallback(
    (e) => {
      // preventDefault inside handleMouseDown suppresses native focus,
      // so re-focus the wrap explicitly to keep keyboard shortcuts alive.
      const wrap = canvasWrapElRef.current;
      if (wrap && typeof wrap.focus === "function") {
        wrap.focus({ preventScroll: true });
      }
      try {
        window.focus();
      } catch (_) {
        /* noop */
      }
      handleMouseDown(e);
    },
    [handleMouseDown, canvasWrapElRef],
  );

  const topics = useMemo(
    () => (Array.isArray(record?.topics) ? record.topics : []),
    [record],
  );

  const sentences = useMemo(
    () => (Array.isArray(record?.sentences) ? record.sentences : []),
    [record],
  );

  const maxLevel = useMemo(() => getMaxTopicLevel(topics), [topics]);
  const allSummaryCards = useMemo(
    () =>
      buildSummaryCards(
        topics,
        record?.topic_summaries,
        record?.topic_summary_index,
      ),
    [topics, record],
  );
  const summaryCards = useMemo(() => {
    // Show one summary per topic branch at the current level: the level-N card
    // if it exists, otherwise the deepest available card for branches that
    // don't go that deep. Cards are ordered by sentence position so they align
    // with the rail visually.
    const eligible = allSummaryCards.filter(
      (card) => card.levelIndex <= selectedLevel,
    );
    const paths = new Set(eligible.map((c) => c.path));
    return eligible
      .filter(
        (card) =>
          !Array.from(paths).some(
            (p) => p !== card.path && p.startsWith(card.path + " > "),
          ),
      )
      .sort(
        (a, b) =>
          a.startSentence - b.startSentence || a.path.localeCompare(b.path),
      );
  }, [allSummaryCards, selectedLevel]);

  // Topic-card positions in summary mode are derived from the rendered
  // summary cards' bounding rects (measured by an effect below).
  const [summaryMetricsState, setSummaryMetricsState] = useState(() => new Map());

  const topicCards = useMemo(() => {
    if (showSummaryMode) {
      // Build cards using synthesized "sentence" indices: each summary card path
      // gets a unique pseudo-sentence number, and the sentenceMetrics map uses
      // those numbers. To keep things simple, we instead patch positions
      // post-build using a path -> {top, height} map.
      const summaryCardMap = new Map(allSummaryCards.map((c) => [c.key, c]));
      const cards = buildTopicCards(topics, selectedLevel, new Map());
      return cards.map((card) => {
        // Find best matching summary card path (exact, ancestor, or descendant).
        const direct = summaryMetricsState.get(card.key);
        if (direct) {
          return { ...card, top: direct.top, height: direct.height };
        }
        let top = Infinity;
        let bottom = -Infinity;
        for (const [key, m] of summaryMetricsState) {
          const path = key.split("#")[0];
          if (
            path === card.fullPath ||
            path.startsWith(card.fullPath + " > ") ||
            card.fullPath.startsWith(path + " > ")
          ) {
            const summaryCard = summaryCardMap.get(key);
            if (summaryCard) {
              const start = summaryCard.startSentence;
              const hasOverlap =
                (start >= card.startSentence && start <= card.endSentence) ||
                (card.startSentence === 0 && card.endSentence === 0);
              if (!hasOverlap) {
                continue;
              }
            }
            if (m.top < top) top = m.top;
            if (m.top + m.height > bottom) bottom = m.top + m.height;
          }
        }
        if (Number.isFinite(top) && Number.isFinite(bottom)) {
          return { ...card, top, height: Math.max(72, bottom - top) };
        }
        return card;
      });
    }
    return buildTopicCards(topics, selectedLevel, sentenceMetrics);
  }, [topics, selectedLevel, sentenceMetrics, showSummaryMode, summaryMetricsState, allSummaryCards]);

  const cardWidth = useMemo(() => getZoomAdjustedCardWidth(scale), [scale]);

  const railWidth = useMemo(
    () =>
      (selectedLevel + 1) * cardWidth +
      selectedLevel * COLUMN_GAP +
      RAIL_PADDING * 2,
    [selectedLevel, cardWidth],
  );

  const zoomAdjustedTopicCards = useMemo(
    () =>
      topicCards.map((card) => ({
        ...card,
        titleFontSize: getTopicTitleFontSize({ scale, height: card.height }),
        right: RAIL_PADDING + card.levelIndex * (cardWidth + COLUMN_GAP),
      })),
    [scale, cardWidth, topicCards],
  );

  const isDone = record?.status === "done";
  const isRecordError = record?.status === "error";
  const isMissing = !record && error === "record not found";
  const isDeleted = !record && error === "record deleted";
  const stage = record?.progress?.stage || record?.status || "loading";

  const activeTopicKey = hoveredTopicKey || selectedTopicKey;

  // ── Measurement ──────────────────────────────────────────────────────────

  const measureSentencePositions = useCallback(() => {
    const wrap = summaryWrapRef.current;
    const articleEl = articleTextRef.current;
    if (!wrap || !articleEl || showSummaryMode) return;

    const wrapRect = wrap.getBoundingClientRect();
    const s = scaleRef.current || 1;
    const nextMetrics = new Map();
    articleEl.querySelectorAll("[data-sentence-index]").forEach((el) => {
      const n = Number(el.getAttribute("data-sentence-index"));
      if (!Number.isInteger(n) || n <= 0) return;
      const r = el.getBoundingClientRect();
      nextMetrics.set(n, {
        top: (r.top - wrapRect.top) / s,
        bottom: (r.bottom - wrapRect.top) / s,
      });
    });
    setSentenceMetrics(nextMetrics);
  }, [scaleRef, showSummaryMode]);

  const measureSummaryPositions = useCallback(() => {
    const wrap = summaryWrapRef.current;
    if (!wrap || !showSummaryMode) return;
    const wrapRect = wrap.getBoundingClientRect();
    const s = scaleRef.current || 1;
    const next = new Map();
    Object.entries(summaryCardRefs.current).forEach(([path, el]) => {
      if (!el) return;
      const r = el.getBoundingClientRect();
      next.set(path, {
        top: (r.top - wrapRect.top) / s,
        height: r.height / s,
      });
    });
    setSummaryMetricsState(next);
  }, [scaleRef, showSummaryMode]);

  useLayoutEffect(() => {
    if (!isDone) return undefined;
    let raf = 0;
    const schedule = () => {
      window.cancelAnimationFrame(raf);
      raf = window.requestAnimationFrame(() => {
        measureSentencePositions();
        measureSummaryPositions();
      });
    };
    schedule();
    window.addEventListener("resize", schedule);

    let resizeObserver = null;
    if (typeof window.ResizeObserver !== "undefined") {
      resizeObserver = new window.ResizeObserver(schedule);
      if (summaryWrapRef.current) resizeObserver.observe(summaryWrapRef.current);
      if (articleTextRef.current)
        resizeObserver.observe(articleTextRef.current);
    }
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener("resize", schedule);
      if (resizeObserver) resizeObserver.disconnect();
    };
  }, [
    isDone,
    showSummaryMode,
    sentences,
    summaryCards,
    measureSentencePositions,
    measureSummaryPositions,
  ]);

  // ── Topic interaction ────────────────────────────────────────────────────

  const zoomToTopic = useCallback(
    (topicKey, card) => {
      if (!topicKey) return;
      if (showSummaryMode) {
        const summaryEl =
          (card && summaryCardRefs.current[card.key]) ||
          summaryCardRefs.current[topicKey] ||
          Object.entries(summaryCardRefs.current).find(
            ([key]) => {
              const path = key.split("#")[0];
              return path === topicKey || path.startsWith(topicKey + " > ");
            },
          )?.[1];
        if (summaryEl) {
          zoomToTarget(summaryEl.getBoundingClientRect());
        }
        return;
      }
      const articleEl = articleTextRef.current;
      const sentenceNumber = Number(card?.startSentence);
      const sel = Number.isInteger(sentenceNumber) && sentenceNumber > 0
        ? articleEl?.querySelector(`[data-sentence-index="${sentenceNumber}"]`)
        : null;
      if (sel) {
        zoomToTarget(sel.getBoundingClientRect());
      }
    },
    [showSummaryMode, zoomToTarget],
  );

  useEffect(() => {
    if (pendingZoomSentence !== null) {
      const sentenceNumber = Number(pendingZoomSentence);
      if (Number.isInteger(sentenceNumber) && sentenceNumber > 0) {
        const articleEl = articleTextRef.current;
        const sel = articleEl?.querySelector(`[data-sentence-index="${sentenceNumber}"]`);
        if (sel) {
          zoomToTarget(sel.getBoundingClientRect());
        }
      }
      setPendingZoomSentence(null);
    }
  }, [pendingZoomSentence, zoomToTarget]);

  // ── Focus ────────────────────────────────────────────────────────────────
  // The modal runs inside an iframe. Keyboard listeners on the iframe's
  // window only fire when the iframe itself has focus, so pull focus in as
  // soon as the canvas mounts and whenever the user clicks inside it.
  useEffect(() => {
    if (!isDone) return;
    try {
      window.focus();
    } catch (_) {
      /* noop */
    }
    const wrap = canvasWrapElRef.current;
    if (wrap && typeof wrap.focus === "function") {
      wrap.focus({ preventScroll: true });
    }
  }, [isDone, canvasWrapElRef]);

  // ── Pipeline lifecycle ───────────────────────────────────────────────────
  // The modal does NOT start the pipeline. It only asks the background to
  // ensure a pipeline is running for this key, then renders whatever state
  // arrives through chrome.storage.onChanged.

  useEffect(() => {
    if (!initialKey) return;
    chrome.runtime.sendMessage({ type: "ensurePipeline", key: initialKey }, (resp) => {
      if (chrome.runtime.lastError) {
        console.warn("PageToLLM Canvas ensurePipeline error:", chrome.runtime.lastError.message);
      } else if (resp && !resp.ok) {
        console.warn("PageToLLM Canvas ensurePipeline failed:", resp.error);
      }
    });
  }, [initialKey]);

  const handleRetry = useCallback(() => {
    if (!initialKey) return;
    chrome.runtime.sendMessage({ type: "retryRecord", key: initialKey }, (resp) => {
      if (chrome.runtime.lastError) {
        console.warn("PageToLLM Canvas retry error:", chrome.runtime.lastError.message);
      } else if (resp && !resp.ok) {
        console.warn("PageToLLM Canvas retry failed:", resp.error);
      }
    });
  }, [initialKey]);

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="pagetollm-modal-root">
      <main className="pagetollm-body">
        {!isDone && (
          <SpinnerOverlay
            stage={stage}
            error={!isRecordError && !isMissing && !isDeleted ? error : null}
            recordError={isRecordError ? (record?.error ?? "") : undefined}
            onRetry={isRecordError ? handleRetry : undefined}
            isMissing={isMissing}
            isDeleted={isDeleted}
          />
        )}
        {isDone && (
          <div className="pagetollm-canvas-main">
            <div
              ref={canvasWrapRef}
              className={`canvas-area${isCanvasDragging ? " is-dragging" : ""}`}
              onMouseDown={handleCanvasMouseDown}
              tabIndex={0}
            >
              <div
                ref={canvasViewportRef}
                className={`canvas-viewport${isFocusingHighlight ? " is-focusing-highlight" : ""}`}
              >
                <div
                  ref={summaryWrapRef}
                  className={`canvas-article-with-summaries${showTopicHierarchy || showSummaryMode ? " has-topic-hierarchy" : ""}${showSummaryMode ? " is-summary-mode" : ""}`}
                  style={{
                    "--canvas-topic-hierarchy-width": `${railWidth}px`,
                  }}
                >
                  {showSummaryMode ? (
                    <CanvasSummaryView
                      summaryViewCards={summaryCards}
                      summaryViewActivePath={activeTopicKey}
                      summaryCardRefs={summaryCardRefs}
                      setHoveredTopicKey={setHoveredTopicKey}
                      articleTextRef={articleTextRef}
                      onShowSourceSentences={(card) => {
                        setSelectedTopicKey(card.path);
                        setShowSummaryMode(false);
                        setPendingZoomSentence(card.startSentence);
                      }}
                    />
                  ) : (
                    <ArticleText
                      sentences={sentences}
                      topics={topics}
                      hoveredTopicKey={hoveredTopicKey}
                      selectedTopicKey={selectedTopicKey}
                      articleTextRef={articleTextRef}
                    />
                  )}

                  <CanvasTopicHierarchyRail
                    show={showTopicHierarchy || showSummaryMode}
                    selectedLevel={selectedLevel}
                    topicCards={zoomAdjustedTopicCards}
                    railWidth={railWidth}
                    cardWidth={cardWidth}
                    activeTopicKey={activeTopicKey}
                    selectedTopicKey={selectedTopicKey}
                    onTopicEnter={(k) => setHoveredTopicKey(k)}
                    onTopicLeave={(k) =>
                      setHoveredTopicKey((cur) => (cur === k ? null : cur))
                    }
                    onTopicClick={(k, card) => {
                      setSelectedTopicKey((cur) => (cur === k ? null : k));
                      zoomToTopic(k, card);
                    }}
                    readTopics={null}
                    onToggleRead={null}
                  />
                </div>
              </div>
            </div>

            <CanvasZoomControls
              onClose={closeModal}
              onNavigate={navigateCanvas}
              onZoomIn={() =>
                setTransformNow(
                  clampScale((scaleRef.current || 1) * 1.2),
                  translateRef.current,
                )
              }
              onZoomOut={() =>
                setTransformNow(
                  clampScale((scaleRef.current || 1) / 1.2),
                  translateRef.current,
                )
              }
              onReset={() => setTransformNow(1, { x: 40, y: 40 })}
              showSummaryMode={showSummaryMode}
              onToggleSummaryMode={() => setShowSummaryMode((v) => !v)}
              showTopicHierarchy={showTopicHierarchy}
              onToggleTopicHierarchy={() => setShowTopicHierarchy((v) => !v)}
              selectedLevel={selectedLevel}
              maxLevel={maxLevel}
              onLevelChange={(level) => {
                setSelectedLevel(level);
                setHoveredTopicKey(null);
                setSelectedTopicKey(null);
              }}
            />
          </div>
        )}
      </main>
    </div>
  );
}
