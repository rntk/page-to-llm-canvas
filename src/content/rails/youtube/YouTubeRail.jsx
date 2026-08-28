import React, { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback } from 'react';
import ArticleChat from '../../../chat/ArticleChat.jsx';
import { formatTimestampLabel } from '../../../utils/youtubeTimestamp.js';
import { HierarchicalCardTitle, RailHead } from '../shared/RailControls.jsx';
import {
  getYouTubeRailCardBodyText,
  getYouTubeRailActiveCardIdFromNormalized,
  getYouTubeRailNextActiveIdFromNormalized,
  getYouTubeRailCardStarts,
  normalizeYouTubeRailCards,
} from './viewModel.js';

const DEFAULT_POLL_MS = 1000;

// How long after a rail-initiated scroll we ignore `scroll` events. Smooth
// scrolling emits events for a few hundred ms after the call, and a card
// expanding/collapsing can nudge `scrollTop` on its own; without this window
// the rail would read its own scrolling as a manual one and pause itself.
const PROGRAMMATIC_SCROLL_GUARD_MS = 1200;

// How long scroll events must stop before we judge an in-flight rail scroll to
// have settled. A user gesture aborts a smooth scroll, so a scroll that goes
// quiet somewhere other than its target was interrupted by the user. Generous
// enough to sit out a janky frame mid-animation: a false pause costs one click,
// a missed one silently drags the reader's position away.
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
  onSelectMode,
  onSelectLevel,
  onClose,
  getCurrentTime,
  onSeek,
  sentences = [],
  recordKey,
  onChatHighlight,
  onClearChatHighlights,
  getChatEventTimestamp,
  pollIntervalMs = DEFAULT_POLL_MS,
}) {
  const isSummary = mode === 'summaries';
  const isChat = mode === 'chat';
  const [activeId, setActiveId] = useState(null);
  const [chatActionsTarget, setChatActionsTarget] = useState(null);
  // Auto-scroll follows playback until the user scrolls the list themselves;
  // from then on the list is theirs to browse until they press Resume. The ref
  // mirrors the state so scroll handlers and effects can read it without
  // re-creating callbacks (which would re-trigger the scroll effect below).
  const [autoScrollEnabled, setAutoScrollEnabled] = useState(true);
  const autoScrollEnabledRef = useRef(true);
  const programmaticScrollUntilRef = useRef(0);
  const programmaticTargetRef = useRef(NaN);
  // When a scroll lands on its target, we close the guard immediately (see
  // handleBodyScroll) so a drag right on its heels isn't swallowed for the
  // rest of the window. That immediate close means a trailing same-animation
  // 'scroll' event — one more frame at (or near) the same spot — would read
  // as the user taking over; this records when we saw the landing so such an
  // event can still be told apart from a real one for a brief moment after.
  const settledAtRef = useRef(0);
  const settleTimerRef = useRef(null);
  const bodyRef = useRef(null);
  const cardRefs = useRef(new Map());

  const normalizedCards = useMemo(
    () => (isChat ? [] : normalizeYouTubeRailCards(cards)),
    [cards, isChat],
  );

  // Start-second lookup for the current card list. Card timestamps change far
  // less often than the poll tick runs, so this is memoized alongside the
  // cards rather than rebuilt (and linearly rescanned) on every tick.
  const starts = useMemo(() => getYouTubeRailCardStarts(normalizedCards), [normalizedCards]);

  // Poll the player position and resolve the active card. Reading time and
  // resolving the index are cheap; we only re-render when the active card
  // actually changes (the setState bails on an equal value).
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
    // A new rail scroll supersedes any in flight: a settle check left over from
    // the previous one would test a stale target and pause for no reason.
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
      // The browser clamps the target to the scrollable range, so store the
      // clamped value: that is the scrollTop the animation will actually land
      // on, and the guard below closes when it gets there.
      beginProgrammaticScroll(clampRailScrollTop(body, targetTop));
      body.scrollTo({ top: targetTop, behavior: 'smooth' });
    },
    [beginProgrammaticScroll],
  );

  const handleResumeAutoScroll = useCallback(() => {
    autoScrollEnabledRef.current = true;
    setAutoScrollEnabled(true);
    // Open the guard before the button unmounts: losing it shrinks the list,
    // which can clamp scrollTop and emit a scroll event that would otherwise
    // read as the user taking over again. `scrollToCard` narrows the guard to
    // its real target; if it bails (no active card yet), the window times out.
    beginProgrammaticScroll();
    scrollToCard(activeId);
  }, [activeId, beginProgrammaticScroll, scrollToCard]);

  // Scrollbar drags and touch panning surface only as `scroll` events, so any
  // scroll the rail did not cause itself counts as the user taking over.
  //
  // The guard window is an upper bound on how long the rail's own smooth scroll
  // may keep emitting events. Two things close it early, so a drag during that
  // window is not swallowed: the scroll landing on its target, and — since a
  // gesture aborts a smooth scroll mid-flight — the scroll going quiet anywhere
  // else, which means the user interrupted it.
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
    // The guard is closed, but a scroll landing exactly on its target can
    // still fire a trailing 'scroll' event for the same animation frame or
    // two after we already saw it land (easing slows to sub-pixel deltas
    // right at the end). Forgive only that: an event arriving right after
    // the landing, at the same spot the rail put it. Anything that's moved
    // away from the target, or arrives well after the landing, is the
    // user's, guard or no guard.
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

  // Applies a manual scroll delta to the list. A gesture that cannot move it
  // (the list fits, or it is already at that end) is not the user taking
  // over, so it must not pause.
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

  // The active card changing re-lays out the list (the summary body expands,
  // the card grows), which can shift `scrollTop` on its own. Open the guard
  // window before paint so that shift is not mistaken for a manual scroll.
  useLayoutEffect(() => {
    beginProgrammaticScroll();
  }, [activeId, beginProgrammaticScroll]);

  // Scroll only on transition: when the active card changes during playback,
  // bring it into the rail's viewport. (No constant scroll — the list is
  // otherwise free for the user to browse.) Once the user has scrolled
  // manually, following playback is off until they resume it.
  useEffect(() => {
    if (!autoScrollEnabledRef.current) return;
    scrollToCard(activeId);
  }, [activeId, scrollToCard]);

  // Re-anchor on a level/mode switch: the card set changes, so resolve the
  // current card immediately (don't wait for the next poll tick) and force a
  // scroll to it even if its id happens to carry over. rAF lets the new cards
  // mount and register their refs before we scroll.
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
            {normalizedCards.map((card) => {
              const isActive = card.id === activeId;
              return (
                <button
                  key={card.id}
                  type="button"
                  ref={setCardRef(card.id)}
                  className={[
                    'pagetollm-yt-rail-card',
                    isSummary ? 'is-summary' : 'is-topic',
                    isActive ? 'is-active' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
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
