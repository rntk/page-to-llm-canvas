import React, { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback } from 'react';
import ArticleChat from '../../../chat/ArticleChat.jsx';
import { formatTimestampLabel } from '../../../utils/youtubeTimestamp.js';
import { HierarchicalCardTitle, RailHead } from '../shared/RailControls.jsx';
import TopicActionsMenu from '../../../components/TopicActionsMenu.jsx';
import { buildTopicRunMenu } from '../../../components/topicActionRuns.js';
import {
  getYouTubeRailCardBodyText,
  getYouTubeRailActiveCardIdFromNormalized,
  getYouTubeRailNextActiveIdFromNormalized,
  getYouTubeRailCardStarts,
  normalizeYouTubeRailCards,
} from './viewModel.js';

const DEFAULT_POLL_MS = 1000;

// Ignore scroll events briefly after the rail scrolls or relayouts cards.
const PROGRAMMATIC_SCROLL_GUARD_MS = 1200;

// A scroll settling short of its target signals user interruption.
const SCROLL_SETTLE_MS = 250;

function clampRailScrollTop(body, scrollTop) {
  const maxScrollTop = Math.max(0, body.scrollHeight - body.clientHeight);
  return Math.max(0, Math.min(maxScrollTop, scrollTop));
}

/**
 * A YouTube-synced rail: a list of topic/summary cards ordered by their
 * transcript timestamp. A poll loop reads the player's current time and marks
 * (and scrolls to) the card for the current moment; clicking a card seeks the
 * player to that moment.
 * @param {object} props Rail properties and callbacks.
 */
export default function YouTubeRail({
  mode,
  maxLevel,
  selectedLevel,
  cards,
  topicActions = [],
  onSelectMode,
  onSelectLevel,
  onClose,
  getCurrentTime,
  onSeek,
  sentences = [],
  recordKey,
  contentRevision,
  onChatHighlight,
  onClearChatHighlights,
  getChatEventTimestamp,
  pollIntervalMs = DEFAULT_POLL_MS,
}) {
  const isSummary = mode === 'summaries';
  const isChat = mode === 'chat';
  const [activeId, setActiveId] = useState(null);
  const [chatActionsTarget, setChatActionsTarget] = useState(null);
  // Slide forward from below and backward from above.
  const [enterDirection, setEnterDirection] = useState('down');
  const previousActiveIndexRef = useRef(-1);
  // Pause auto-scroll after manual scrolling until Resume is pressed.
  // The ref keeps scroll handlers stable across state changes.
  const [autoScrollEnabled, setAutoScrollEnabled] = useState(true);
  const autoScrollEnabledRef = useRef(true);
  const programmaticScrollUntilRef = useRef(0);
  const programmaticTargetRef = useRef(NaN);
  // Remember the landing to ignore trailing events without swallowing a new drag.
  const settledAtRef = useRef(0);
  const settleTimerRef = useRef(null);
  const bodyRef = useRef(null);
  const cardRefs = useRef(new Map());

  const normalizedCards = useMemo(
    () => (isChat ? [] : normalizeYouTubeRailCards(cards)),
    [cards, isChat],
  );
  const topicMenus = useMemo(
    () =>
      new Map(
        normalizedCards.map((card) => [
          card.id,
          buildTopicRunMenu(topicActions, card.path, card.sentences),
        ]),
      ),
    [normalizedCards, topicActions],
  );

  // Memoize timestamps across player polling ticks.
  const starts = useMemo(() => getYouTubeRailCardStarts(normalizedCards), [normalizedCards]);

  // Poll player time; render only when the active card changes.
  const cardsRef = useRef(normalizedCards);
  const startsRef = useRef(starts);
  useEffect(() => {
    cardsRef.current = normalizedCards;
    startsRef.current = starts;
  }, [normalizedCards, starts]);
  const getCurrentTimeRef = useRef(getCurrentTime);
  useEffect(() => {
    getCurrentTimeRef.current = getCurrentTime;
  }, [getCurrentTime]);

  const beginProgrammaticScroll = useCallback((targetTop = NaN) => {
    programmaticScrollUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_GUARD_MS;
    programmaticTargetRef.current = targetTop;
    // Discard settle checks for a superseded scroll target.
    window.clearTimeout(settleTimerRef.current);
    settleTimerRef.current = null;
  }, []);

  const pauseAutoScroll = useCallback(() => {
    if (!autoScrollEnabledRef.current) return;
    autoScrollEnabledRef.current = false;
    setAutoScrollEnabled(false);
  }, []);

  const scrollToCard = useCallback(
    (id) => {
      if (!id) return;
      const body = bodyRef.current;
      const el = cardRefs.current.get(id);
      if (!body || !el || typeof body.scrollTo !== 'function') return;

      const bodyRect = body.getBoundingClientRect();
      const cardRect = el.getBoundingClientRect();
      const nextTop =
        body.scrollTop + cardRect.top - bodyRect.top - body.clientHeight / 2 + cardRect.height / 2;

      const targetTop = Math.max(0, nextTop);
      // Compare landing against the browser's clamped scroll target.
      beginProgrammaticScroll(clampRailScrollTop(body, targetTop));
      body.scrollTo({ top: targetTop, behavior: 'smooth' });
    },
    [beginProgrammaticScroll],
  );

  const handleResumeAutoScroll = useCallback(() => {
    autoScrollEnabledRef.current = true;
    setAutoScrollEnabled(true);
    // Guard before Resume unmounts; relayout may itself emit a scroll event.
    beginProgrammaticScroll();
    scrollToCard(activeId);
  }, [activeId, beginProgrammaticScroll, scrollToCard]);

  // Treat unguarded scroll events as manual input, including drags and touch.
  // Close the guard on target arrival or an interrupted smooth scroll.
  const handleBodyScroll = useCallback(() => {
    if (Date.now() < programmaticScrollUntilRef.current) {
      const body = bodyRef.current;
      const distanceToTarget = body
        ? Math.abs(body.scrollTop - programmaticTargetRef.current)
        : NaN;
      if (distanceToTarget <= 1) {
        programmaticScrollUntilRef.current = 0;
        settledAtRef.current = Date.now();
        window.clearTimeout(settleTimerRef.current);
        settleTimerRef.current = null;
        return;
      }
      // An unknown target (NaN distance) is not ours to judge: let the window
      // time out rather than guess.
      if (!Number.isFinite(distanceToTarget)) return;
      window.clearTimeout(settleTimerRef.current);
      settleTimerRef.current = window.setTimeout(() => {
        settleTimerRef.current = null;
        const currentBody = bodyRef.current;
        if (!currentBody) return;
        if (Math.abs(currentBody.scrollTop - programmaticTargetRef.current) <= 1) return;
        programmaticScrollUntilRef.current = 0;
        pauseAutoScroll();
      }, SCROLL_SETTLE_MS);
      return;
    }
    // Ignore only immediate trailing events at the rail's landing position.
    const body = bodyRef.current;
    const settledRecently = Date.now() - settledAtRef.current <= SCROLL_SETTLE_MS;
    if (
      settledRecently &&
      body &&
      Number.isFinite(programmaticTargetRef.current) &&
      Math.abs(body.scrollTop - programmaticTargetRef.current) <= 1
    ) {
      return;
    }
    pauseAutoScroll();
  }, [pauseAutoScroll]);

  // Do not pause playback tracking for a gesture that cannot move the list.
  const scrollRailBy = useCallback(
    (body, delta) => {
      const nextScrollTop = clampRailScrollTop(body, body.scrollTop + delta);
      if (nextScrollTop === body.scrollTop) return;
      pauseAutoScroll();
      body.scrollTop = nextScrollTop;
    },
    [pauseAutoScroll],
  );

  const handleBodyWheel = useCallback(
    (event) => {
      const body = bodyRef.current;
      if (!body) return;

      event.preventDefault();
      event.stopPropagation();

      const pageDelta = body.clientHeight || window.innerHeight || 0;
      const deltaMultiplier = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? pageDelta : 1;
      scrollRailBy(body, event.deltaY * deltaMultiplier);
    },
    [scrollRailBy],
  );

  const handleBodyKeyDown = useCallback(
    (event) => {
      const body = bodyRef.current;
      if (!body) return;

      const pageStep = Math.max(1, Math.floor(body.clientHeight * 0.85));
      const keyScrollDeltas = {
        ArrowDown: 40,
        ArrowUp: -40,
        PageDown: pageStep,
        PageUp: -pageStep,
        Home: -body.scrollTop,
        End: body.scrollHeight - body.clientHeight - body.scrollTop,
      };
      const delta = keyScrollDeltas[event.key];
      if (delta == null) return;

      event.preventDefault();
      event.stopPropagation();
      scrollRailBy(body, delta);
    },
    [scrollRailBy],
  );

  useEffect(() => () => window.clearTimeout(settleTimerRef.current), []);

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      const time = getCurrentTimeRef.current ? getCurrentTimeRef.current() : null;
      if (time == null) return;
      setActiveId((prev) =>
        getYouTubeRailNextActiveIdFromNormalized(cardsRef.current, time, prev, startsRef.current),
      );
    };
    const id = window.setInterval(tick, pollIntervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [pollIntervalMs]);

  // Guard before card expansion shifts scrollTop during layout.
  useLayoutEffect(() => {
    beginProgrammaticScroll();
  }, [activeId, beginProgrammaticScroll]);

  // Scroll on active-card changes while playback tracking is enabled.
  useEffect(() => {
    if (!autoScrollEnabledRef.current) return;
    scrollToCard(activeId);
  }, [activeId, scrollToCard]);

  // On mode or level changes, wait for card refs before scrolling to the new card.
  useEffect(() => {
    const time = getCurrentTimeRef.current ? getCurrentTimeRef.current() : null;
    const next = getYouTubeRailActiveCardIdFromNormalized(
      normalizedCards,
      time == null ? NaN : time,
      starts,
    );
    setActiveId(next);
    if (!autoScrollEnabledRef.current) return undefined;
    const raf = window.requestAnimationFrame(() => scrollToCard(next));
    return () => window.cancelAnimationFrame(raf);
  }, [normalizedCards, starts, scrollToCard]);

  const activeIndex = useMemo(
    () => normalizedCards.findIndex((card) => card.id === activeId),
    [normalizedCards, activeId],
  );

  // Set slide direction before paint for both playback and seeking.
  useLayoutEffect(() => {
    const previousIndex = previousActiveIndexRef.current;
    previousActiveIndexRef.current = activeIndex;
    if (activeIndex < 0 || previousIndex < 0 || previousIndex === activeIndex) return;
    setEnterDirection(activeIndex > previousIndex ? 'down' : 'up');
  }, [activeIndex]);

  const setCardRef = useCallback(
    (id) => (el) => {
      if (el) cardRefs.current.set(id, el);
      else cardRefs.current.delete(id);
    },
    [],
  );

  return (
    <>
      <RailHead
        mode={mode}
        onSelectMode={onSelectMode}
        isChat={isChat}
        setChatActionsTarget={setChatActionsTarget}
        maxLevel={maxLevel}
        selectedLevel={selectedLevel}
        onSelectLevel={onSelectLevel}
        onClose={onClose}
      />
      <div
        ref={bodyRef}
        className={isChat ? 'pagetollm-rail-body is-chat' : 'pagetollm-yt-rail-body'}
        tabIndex={isChat ? undefined : 0}
        onWheel={isChat ? undefined : handleBodyWheel}
        onKeyDown={isChat ? undefined : handleBodyKeyDown}
        onScroll={isChat ? undefined : handleBodyScroll}
      >
        {isChat ? (
          <ArticleChat
            recordKey={recordKey}
            sentences={sentences}
            contentRevision={contentRevision}
            onHighlight={onChatHighlight}
            onClearHighlights={onClearChatHighlights}
            onEscape={onClose}
            headerActionsTarget={chatActionsTarget}
            subject="video"
            getEventTimestamp={getChatEventTimestamp}
          />
        ) : normalizedCards.length === 0 ? (
          <div className="pagetollm-yt-rail-empty">
            No timestamped {isSummary ? 'summaries' : 'topics'} for this video.
          </div>
        ) : (
          <>
            {/* Laid out like the in-page summary stack: the card for the
                current moment is the one prominent card, and the rest read as
                a dimmed list of titles on either side of it. */}
            {normalizedCards.map((card, index) => {
              const isActive = card.id === activeId;
              const topicMenu = topicMenus.get(card.id);
              const position = isActive
                ? `is-active is-enter-${enterDirection}`
                : activeIndex >= 0 && index < activeIndex
                  ? 'is-before'
                  : 'is-after';
              return (
                <div
                  key={card.id}
                  className={
                    isActive
                      ? `pagetollm-yt-rail-card-wrap ${position}`
                      : 'pagetollm-yt-rail-card-wrap'
                  }
                >
                  <button
                    type="button"
                    ref={setCardRef(card.id)}
                    className={[
                      'pagetollm-yt-rail-card',
                      isSummary ? 'is-summary' : 'is-topic',
                      position,
                    ].join(' ')}
                    style={{ '--pagetollm-card-accent': card.accent }}
                    onClick={() => onSeek(card.seconds)}
                    title={`Jump to ${formatTimestampLabel(card.seconds)}`}
                  >
                    <div className="pagetollm-yt-rail-card-head">
                      <span className="pagetollm-yt-rail-card-time">
                        {formatTimestampLabel(card.seconds)}
                      </span>
                      <HierarchicalCardTitle
                        className="pagetollm-yt-rail-card-title"
                        name={card.name}
                        path={card.path}
                      />
                    </div>
                    {/* Only the card for the current moment shows its summary; the
                    rest stay as titles so the surrounding topics remain visible. */}
                    {isSummary && isActive && (
                      <div className="pagetollm-yt-rail-card-body">
                        {getYouTubeRailCardBodyText(card)}
                      </div>
                    )}
                  </button>
                  {topicMenu && (
                    <TopicActionsMenu
                      actions={topicMenu.actions}
                      topic={topicMenu.topic}
                      classPrefix="pagetollm"
                    />
                  )}
                </div>
              );
            })}
            {/* Pinned to the bottom of the list while playback tracking is
                paused: press it to follow the video again and jump back to the
                card for the current moment. */}
            {!autoScrollEnabled && (
              <button
                type="button"
                className="pagetollm-yt-rail-resume"
                title="Resume auto-scroll and jump to the current topic"
                onClick={handleResumeAutoScroll}
              >
                ↓ Resume auto-scroll
              </button>
            )}
          </>
        )}
      </div>
    </>
  );
}
