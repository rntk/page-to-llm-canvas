import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { formatTimestampLabel } from '../utils/youtubeTimestamp.js';
import {
  getYouTubeRailCardBodyText,
  getYouTubeRailActiveCardIdFromNormalized,
  getYouTubeRailNextActiveIdFromNormalized,
  normalizeYouTubeRailCards,
} from './youtubeRailViewModel.js';

const DEFAULT_POLL_MS = 1000;

function clampRailScrollTop(body, scrollTop) {
  const maxScrollTop = Math.max(0, body.scrollHeight - body.clientHeight);
  return Math.max(0, Math.min(maxScrollTop, scrollTop));
}

function ModeDropdown({ mode, onSelectMode }) {
  const activeMode = mode === 'summaries' ? 'summaries' : 'topics';
  return (
    <select
      className="pagetollm-rail-mode-select pagetollm-rail-title"
      aria-label="Rail view"
      value={activeMode}
      onChange={(event) => onSelectMode(event.target.value)}
    >
      <option value="topics">Topics</option>
      <option value="summaries">Summaries</option>
    </select>
  );
}

function LevelSwitcher({ maxLevel, selectedLevel, onSelectLevel }) {
  if (maxLevel <= 0) return null;
  return (
    <div className="pagetollm-rail-level-switcher">
      <div className="pagetollm-rail-level-buttons">
        {Array.from({ length: maxLevel + 1 }, (_, level) => (
          <button
            key={level}
            type="button"
            className={`pagetollm-rail-level-btn${selectedLevel === level ? ' active' : ''}`}
            title={`Switch to level ${level}`}
            onClick={() => onSelectLevel(level)}
          >
            L{level}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * A YouTube-synced rail: a list of topic/summary cards ordered by their
 * transcript timestamp. A poll loop reads the player's current time and marks
 * (and scrolls to) the card for the current moment; clicking a card seeks the
 * player to that moment.
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
  pollIntervalMs = DEFAULT_POLL_MS,
}) {
  const isSummary = mode === 'summaries';
  const [activeId, setActiveId] = useState(null);
  const bodyRef = useRef(null);
  const cardRefs = useRef(new Map());

  const normalizedCards = useMemo(() => normalizeYouTubeRailCards(cards), [cards]);

  // Poll the player position and resolve the active card. Reading time and
  // resolving the index are cheap; we only re-render when the active card
  // actually changes (the setState bails on an equal value).
  const cardsRef = useRef(normalizedCards);
  useEffect(() => {
    cardsRef.current = normalizedCards;
  }, [normalizedCards]);
  const getCurrentTimeRef = useRef(getCurrentTime);
  useEffect(() => {
    getCurrentTimeRef.current = getCurrentTime;
  }, [getCurrentTime]);

  const scrollToCard = useCallback((id) => {
    if (!id) return;
    const body = bodyRef.current;
    const el = cardRefs.current.get(id);
    if (!body || !el || typeof body.scrollTo !== 'function') return;

    const bodyRect = body.getBoundingClientRect();
    const cardRect = el.getBoundingClientRect();
    const nextTop =
      body.scrollTop + cardRect.top - bodyRect.top - body.clientHeight / 2 + cardRect.height / 2;

    body.scrollTo({ top: Math.max(0, nextTop), behavior: 'smooth' });
  }, []);

  const handleBodyWheel = useCallback((event) => {
    const body = bodyRef.current;
    if (!body) return;

    event.preventDefault();
    event.stopPropagation();

    const pageDelta = body.clientHeight || window.innerHeight || 0;
    const deltaMultiplier = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? pageDelta : 1;
    body.scrollTop = clampRailScrollTop(body, body.scrollTop + event.deltaY * deltaMultiplier);
  }, []);

  const handleBodyKeyDown = useCallback((event) => {
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
    body.scrollTop = clampRailScrollTop(body, body.scrollTop + delta);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      const time = getCurrentTimeRef.current ? getCurrentTimeRef.current() : null;
      if (time == null) return;
      setActiveId((prev) => getYouTubeRailNextActiveIdFromNormalized(cardsRef.current, time, prev));
    };
    const id = window.setInterval(tick, pollIntervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [pollIntervalMs]);

  // Scroll only on transition: when the active card changes during playback,
  // bring it into the rail's viewport. (No constant scroll — the list is
  // otherwise free for the user to browse.)
  useEffect(() => {
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
    );
    setActiveId(next);
    const raf = window.requestAnimationFrame(() => scrollToCard(next));
    return () => window.cancelAnimationFrame(raf);
  }, [normalizedCards, scrollToCard]);

  const setCardRef = useCallback(
    (id) => (el) => {
      if (el) cardRefs.current.set(id, el);
      else cardRefs.current.delete(id);
    },
    [],
  );

  return (
    <>
      <div className="pagetollm-rail-head">
        <ModeDropdown mode={mode} onSelectMode={onSelectMode} />
        <LevelSwitcher
          maxLevel={maxLevel}
          selectedLevel={selectedLevel}
          onSelectLevel={onSelectLevel}
        />
        <button className="pagetollm-rail-close" type="button" title="Close rail" onClick={onClose}>
          ×
        </button>
      </div>
      <div
        ref={bodyRef}
        className="pagetollm-yt-rail-body"
        tabIndex={0}
        onWheel={handleBodyWheel}
        onKeyDown={handleBodyKeyDown}
      >
        {normalizedCards.length === 0 ? (
          <div className="pagetollm-yt-rail-empty">
            No timestamped {isSummary ? 'summaries' : 'topics'} for this video.
          </div>
        ) : (
          normalizedCards.map((card) => {
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
                  <span className="pagetollm-yt-rail-card-title" title={card.path} lang="en">
                    {card.name}
                  </span>
                </div>
                {isSummary && (
                  <div className="pagetollm-yt-rail-card-body">
                    {getYouTubeRailCardBodyText(card)}
                  </div>
                )}
              </button>
            );
          })
        )}
      </div>
    </>
  );
}
