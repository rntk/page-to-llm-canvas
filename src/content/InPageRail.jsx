import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { computeSummaryCursorState } from './summaryCursor.js';
import ArticleChat from '../chat/ArticleChat.jsx';

const SUMMARY_CURSOR_MIN_TOP = 112;

const RAIL_MODE_OPTIONS = new Set(['topics', 'summaries', 'chat', 'hierarchy', 'canvas']);

function ModeDropdown({ mode, onSelectMode }) {
  const activeMode = RAIL_MODE_OPTIONS.has(mode) ? mode : 'topics';

  return (
    <select
      className="pagetollm-rail-mode-select pagetollm-rail-title"
      aria-label="Rail view"
      value={activeMode}
      onChange={(event) => onSelectMode(event.target.value)}
    >
      <option value="topics">Topics</option>
      <option value="summaries">Summaries</option>
      <option value="chat">Chat</option>
      <option value="hierarchy">Hierarchy view</option>
      <option value="canvas">Canvas view</option>
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
            data-level={level}
            onClick={() => onSelectLevel(level)}
          >
            L{level}
          </button>
        ))}
      </div>
    </div>
  );
}

function RailCard({ card, isSummary, isFront, onEnter, onLeave, onFocus, onOpen }) {
  const style = {
    top: `${card.box.top}px`,
    '--pagetollm-card-accent': card.accent,
    '--pagetollm-card-top': `${card.box.top}px`,
    '--pagetollm-card-height': `${card.box.height}px`,
  };
  if (isSummary) {
    style.height = `${card.box.height}px`;
  } else {
    style.minHeight = `${card.box.height}px`;
  }

  return (
    <button
      type="button"
      className={[
        'pagetollm-rail-card',
        isSummary ? 'is-summary' : 'is-topic',
        isFront ? 'is-front' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={style}
      onMouseEnter={() => onEnter(card)}
      onMouseLeave={() => onLeave(card)}
      onFocus={() => onFocus(card)}
      onPointerDown={() => onFocus(card)}
      onClick={() => onOpen(card)}
    >
      <div className="pagetollm-rail-card-content">
        <div className="pagetollm-rail-card-title" title={card.path} lang="en">
          {card.name}
        </div>
        {isSummary ? (
          <div className="pagetollm-rail-card-body">{card.text || '(no summary)'}</div>
        ) : (
          <div className="pagetollm-rail-card-meta">{card.sentences.length} sent.</div>
        )}
      </div>
    </button>
  );
}

const MemoizedRailCard = React.memo(RailCard);

function getScrollContainerTop(scrollContainer) {
  if (!scrollContainer || scrollContainer === window) return window.scrollY;
  return scrollContainer.scrollTop;
}

function getScrollContainerViewportHeight(scrollContainer) {
  if (!scrollContainer || scrollContainer === window) return window.innerHeight;
  return scrollContainer.clientHeight || window.innerHeight;
}

function getScrollContainerViewportTop(scrollContainer) {
  if (!scrollContainer || scrollContainer === window) return 0;
  return scrollContainer.getBoundingClientRect().top;
}

function SummaryCursorView({
  cards,
  bodyRef,
  bodyHeight,
  scrollContainer,
  onHighlightCard,
  onScrollToCard,
}) {
  const [activeCardId, setActiveCardId] = useState(null);
  const [cursorTop, setCursorTop] = useState(SUMMARY_CURSOR_MIN_TOP);
  const cardsRef = useRef(cards);
  useEffect(() => {
    cardsRef.current = cards;
  }, [cards]);
  const onHighlightCardRef = useRef(onHighlightCard);
  useEffect(() => {
    onHighlightCardRef.current = onHighlightCard;
  }, [onHighlightCard]);

  const activeCard = useMemo(
    () => cards.find((card) => card.id === activeCardId) || null,
    [activeCardId, cards],
  );

  const updateActiveCard = useCallback(() => {
    const body = bodyRef.current;
    const currentCards = cardsRef.current;
    if (!body || currentCards.length === 0) {
      setActiveCardId(null);
      return;
    }

    const nextState = computeSummaryCursorState({
      cards: currentCards,
      bodyTop: body.getBoundingClientRect().top,
      containerTop: getScrollContainerViewportTop(scrollContainer),
      containerHeight: getScrollContainerViewportHeight(scrollContainer),
      scrollTop: getScrollContainerTop(scrollContainer),
      isWindowScroll: !scrollContainer || scrollContainer === window,
    });
    const nextCursorTop = nextState.cursorTop;
    setCursorTop(nextCursorTop);
    setActiveCardId(nextState.activeCardId);
  }, [bodyRef, scrollContainer]);

  useEffect(() => {
    let frameId = 0;
    const scheduleUpdate = () => {
      if (frameId) return;
      frameId = window.requestAnimationFrame(() => {
        frameId = 0;
        updateActiveCard();
      });
    };

    updateActiveCard();
    const target = scrollContainer || window;
    target.addEventListener('scroll', scheduleUpdate, { passive: true });
    if (target !== window) {
      window.addEventListener('scroll', scheduleUpdate, { passive: true });
    }
    window.addEventListener('resize', scheduleUpdate);
    return () => {
      if (frameId) window.cancelAnimationFrame(frameId);
      target.removeEventListener('scroll', scheduleUpdate);
      if (target !== window) {
        window.removeEventListener('scroll', scheduleUpdate);
      }
      window.removeEventListener('resize', scheduleUpdate);
    };
  }, [updateActiveCard, scrollContainer]);

  useEffect(() => {
    updateActiveCard();
  }, [cards, updateActiveCard]);

  useEffect(() => {
    const highlightFn = onHighlightCardRef.current;
    if (activeCard) {
      highlightFn(activeCard, true);
    }
    return () => {
      if (activeCard) {
        highlightFn(activeCard, false);
      }
    };
  }, [activeCard]);

  const cursorTopStyle = `${cursorTop}px`;

  return (
    <>
      <div
        className="pagetollm-summary-cursor-line"
        style={{ '--pagetollm-summary-cursor-top': cursorTopStyle }}
        aria-hidden="true"
      />
      <div className="pagetollm-summary-cursor-hitbox" style={{ height: `${bodyHeight}px` }} />
      {activeCard ? (
        <button
          type="button"
          className="pagetollm-summary-active-card"
          style={{
            '--pagetollm-summary-cursor-top': cursorTopStyle,
            '--pagetollm-card-accent': activeCard.accent,
          }}
          onClick={() => onScrollToCard(activeCard)}
        >
          <div className="pagetollm-summary-active-card-title" title={activeCard.path} lang="en">
            {activeCard.name}
          </div>
          <div className="pagetollm-summary-active-card-body">
            {activeCard.text || '(no summary)'}
          </div>
        </button>
      ) : null}
    </>
  );
}

export default function InPageRail({
  mode,
  maxLevel,
  selectedLevel,
  cards,
  bodyHeight,
  onClose,
  onSelectMode,
  onSelectLevel,
  onHighlightCard,
  onScrollToCard,
  scrollContainer,
  summariesDisabled = false,
  sentences = [],
  onChatHighlight,
  onClearChatHighlights,
  recordKey,
}) {
  const [frontCardId, setFrontCardId] = useState(null);
  const [scrollOffset, setScrollOffset] = useState(() => getScrollContainerTop(scrollContainer));
  const bodyRef = useRef(null);
  const isSummary = mode === 'summaries';
  const isChat = mode === 'chat';
  const showSummariesDisabledNotice = isSummary && summariesDisabled;
  const normalizedHeight = useMemo(() => `${bodyHeight}px`, [bodyHeight]);
  const isNestedScroll = scrollContainer && scrollContainer !== window;

  useEffect(() => {
    const target = scrollContainer || window;
    let frameId = 0;
    const updateScrollOffset = () => {
      frameId = 0;
      setScrollOffset(getScrollContainerTop(scrollContainer));
    };
    const scheduleUpdate = () => {
      if (frameId) return;
      frameId = window.requestAnimationFrame(updateScrollOffset);
    };

    updateScrollOffset();
    target.addEventListener('scroll', scheduleUpdate, { passive: true });
    return () => {
      if (frameId) window.cancelAnimationFrame(frameId);
      target.removeEventListener('scroll', scheduleUpdate);
    };
  }, [scrollContainer]);

  const bringForward = useCallback((card) => setFrontCardId(card.id), []);

  const handleCardEnter = useCallback(
    (card) => {
      bringForward(card);
      onHighlightCard(card, true);
    },
    [bringForward, onHighlightCard],
  );

  const handleCardLeave = useCallback(
    (card) => {
      onHighlightCard(card, false);
    },
    [onHighlightCard],
  );

  const handleCardOpen = useCallback(
    (card) => {
      bringForward(card);
      onScrollToCard(card);
    },
    [bringForward, onScrollToCard],
  );

  const bodyStyle = {
    height: normalizedHeight,
    transform: isNestedScroll && !isSummary ? `translateY(${-scrollOffset}px)` : undefined,
    '--pagetollm-scroll-offset': `${scrollOffset}px`,
  };

  return (
    <>
      <div className="pagetollm-rail-head">
        <ModeDropdown mode={mode} onSelectMode={onSelectMode} />
        {!isChat ? (
          <LevelSwitcher
            maxLevel={maxLevel}
            selectedLevel={selectedLevel}
            onSelectLevel={onSelectLevel}
          />
        ) : null}
        <button className="pagetollm-rail-close" type="button" title="Close rail" onClick={onClose}>
          ×
        </button>
      </div>
      <div
        className={[
          'pagetollm-rail-body',
          isNestedScroll ? 'is-nested-scroll' : '',
          isChat ? 'is-chat' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        ref={bodyRef}
        style={bodyStyle}
      >
        {isChat ? (
          <ArticleChat
            recordKey={recordKey}
            sentences={sentences}
            onHighlight={onChatHighlight}
            onClearHighlights={onClearChatHighlights}
            onEscape={onClose}
          />
        ) : showSummariesDisabledNotice ? (
          <div className="pagetollm-rail-empty">
            Summaries are disabled. Enable them in the extension settings and reprocess this page to
            see them here.
          </div>
        ) : isSummary ? (
          <SummaryCursorView
            cards={cards}
            bodyRef={bodyRef}
            bodyHeight={bodyHeight}
            scrollContainer={scrollContainer}
            onHighlightCard={onHighlightCard}
            onScrollToCard={onScrollToCard}
          />
        ) : (
          cards.map((card) => (
            <MemoizedRailCard
              key={card.id}
              card={card}
              isSummary={isSummary}
              isFront={frontCardId === card.id}
              onEnter={handleCardEnter}
              onLeave={handleCardLeave}
              onFocus={bringForward}
              onOpen={handleCardOpen}
            />
          ))
        )}
      </div>
    </>
  );
}
