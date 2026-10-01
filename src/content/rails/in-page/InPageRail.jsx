import React, { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback } from 'react';
import { computeSummaryCursorState, SUMMARY_CURSOR_MIN_TOP } from './summaryCursor.js';
import ArticleChat from '../../../chat/ArticleChat.jsx';
import { HierarchicalCardTitle, RailHead } from '../shared/RailControls.jsx';
import TopicActionsMenu from '../../../components/TopicActionsMenu.jsx';
import {
  BRACE_WIDTH,
  curlyBracePath,
  computeNoteColumn,
  getViewportWidth,
  layoutNotes,
} from './marginNotes.js';

const SUMMARIES_DISABLED_NOTICE = (
  <div className="pagetollm-rail-empty">
    Summaries are disabled. Enable them in the extension settings and reprocess this page to see
    them here.
  </div>
);

function CurlyBrace({ height }) {
  const d = curlyBracePath(BRACE_WIDTH, height);
  return (
    <svg
      className="pagetollm-note-brace"
      width={BRACE_WIDTH}
      height={height}
      viewBox={`0 0 ${BRACE_WIDTH} ${height}`}
      aria-hidden="true"
    >
      {/* Wide transparent stroke: the visible pen line is too thin to hover. */}
      <path className="pagetollm-note-brace-hit" d={d} />
      <path className="pagetollm-note-brace-line" d={d} />
    </svg>
  );
}

function RailCard({ card, isFront, onEnter, onLeave, onFocus, onOpen, topicActions }) {
  const style = {
    top: `${card.box.top}px`,
    height: `${card.box.height}px`,
    '--pagetollm-card-accent': card.accent,
    '--pagetollm-card-top': `${card.box.top}px`,
    '--pagetollm-card-height': `${card.box.height}px`,
  };

  return (
    <div
      className={isFront ? 'pagetollm-rail-card-wrap is-front' : 'pagetollm-rail-card-wrap'}
      style={style}
      onMouseEnter={() => onEnter(card)}
      onMouseLeave={() => onLeave(card)}
    >
      <button
        type="button"
        className={['pagetollm-rail-card', 'is-topic', isFront ? 'is-front' : '']
          .filter(Boolean)
          .join(' ')}
        style={{
          '--pagetollm-card-top': style['--pagetollm-card-top'],
          '--pagetollm-card-height': style['--pagetollm-card-height'],
        }}
        title={`${card.sentences.length} sent.`}
        onFocus={(event) => onFocus(card, event.currentTarget)}
        onPointerDown={() => onFocus(card)}
        onClick={() => onOpen(card)}
        // The title button provides keyboard and screen-reader access.
        tabIndex={-1}
        aria-hidden="true"
      >
        <CurlyBrace height={card.box.height} />
      </button>
      <div className="pagetollm-note-label" onClick={() => onOpen(card)}>
        <button
          type="button"
          className="pagetollm-note-open"
          onFocus={(event) => onFocus(card, event.currentTarget)}
          onPointerDown={() => onFocus(card)}
        >
          <HierarchicalCardTitle
            className="pagetollm-rail-card-title"
            name={card.name}
            path={card.path}
          />
        </button>
        {topicActions.length > 0 && (
          <TopicActionsMenu
            actions={topicActions}
            topic={topicForCard(card)}
            classPrefix="pagetollm"
          />
        )}
      </div>
    </div>
  );
}

const MemoizedRailCard = React.memo(RailCard);

// Classic layout: a card in the rail column, opposite its sentences.
function TopicCard({ card, isFront, onEnter, onLeave, onFocus, onOpen, topicActions }) {
  const style = {
    top: `${card.box.top}px`,
    minHeight: `${card.box.height}px`,
    '--pagetollm-card-accent': card.accent,
    '--pagetollm-card-top': `${card.box.top}px`,
    '--pagetollm-card-height': `${card.box.height}px`,
  };

  return (
    <div
      className={isFront ? 'pagetollm-topic-card-wrap is-front' : 'pagetollm-topic-card-wrap'}
      style={style}
      onMouseEnter={() => onEnter(card)}
      onMouseLeave={() => onLeave(card)}
    >
      <button
        type="button"
        className={isFront ? 'pagetollm-topic-card is-front' : 'pagetollm-topic-card'}
        style={{ minHeight: style.minHeight }}
        onFocus={(event) => onFocus(card, event.currentTarget)}
        onPointerDown={() => onFocus(card)}
        onClick={() => onOpen(card)}
      >
        <div className="pagetollm-topic-card-content">
          <HierarchicalCardTitle
            className="pagetollm-rail-card-title"
            name={card.name}
            path={card.path}
          />
          <div className="pagetollm-topic-card-meta">{card.sentences.length} sent.</div>
        </div>
      </button>
      {topicActions.length > 0 && (
        <TopicActionsMenu
          actions={topicActions}
          topic={topicForCard(card)}
          classPrefix="pagetollm"
        />
      )}
    </div>
  );
}

function topicForCard(card) {
  return {
    path: card.path,
    startSentence: card.sentences[0],
    endSentence: card.sentences[card.sentences.length - 1],
  };
}

const MemoizedTopicCard = React.memo(TopicCard);

function getScrollContainerTop(scrollContainer, scrollWindow = window) {
  if (!scrollContainer || scrollContainer === scrollWindow) return scrollWindow.scrollY;
  return scrollContainer.scrollTop;
}

function getScrollContainerViewportHeight(scrollContainer, scrollWindow = window) {
  if (!scrollContainer || scrollContainer === scrollWindow) return scrollWindow.innerHeight;
  return scrollContainer.clientHeight || scrollWindow.innerHeight;
}

function getScrollContainerViewportTop(scrollContainer, scrollWindow = window) {
  if (!scrollContainer || scrollContainer === scrollWindow) return 0;
  return scrollContainer.getBoundingClientRect().top;
}

/**
 * Remaining scroll distance, or Infinity when the range is unavailable.
 * @param {Window|Element|null} scrollContainer Scroller the rail follows.
 * @param {Window} scrollWindow Window the rail lives in.
 * @returns {number} Remaining scroll in pixels.
 */
function getRemainingScroll(scrollContainer, scrollWindow) {
  const isWindowScroll = !scrollContainer || scrollContainer === scrollWindow;
  const scroller = isWindowScroll ? scrollWindow.document?.documentElement : scrollContainer;
  if (!scroller) return Infinity;
  const viewportHeight = isWindowScroll ? scrollWindow.innerHeight : scroller.clientHeight;
  const maxScrollTop = scroller.scrollHeight - viewportHeight;
  // No scroll boundary exists when content fits or layout is unavailable.
  if (!(maxScrollTop > 0)) return Infinity;
  const currentTop = isWindowScroll ? scrollWindow.scrollY : scroller.scrollTop;
  return Math.max(0, maxScrollTop - currentTop);
}

function getEffectiveScrollOffset({
  scrollContainer,
  scrollWindow,
  isNestedScroll,
  projectedScrollContainerTop,
}) {
  const scrollOffset = getScrollContainerTop(scrollContainer, scrollWindow);
  if (!isNestedScroll) return scrollOffset;
  // Card boxes retain the container's viewport top from projection time.
  // Treat later outer-page movement as additional content-space scrolling.
  const currentContainerTop = scrollContainer.getBoundingClientRect().top;
  return scrollOffset - (currentContainerTop - projectedScrollContainerTop);
}

function SummaryTopicTitle({ card, onEnter, onLeave, onOpen, topicActions }) {
  return (
    <div
      className="pagetollm-summary-card-wrap"
      onMouseEnter={() => onEnter(card)}
      onMouseLeave={() => onLeave(card)}
    >
      <button
        type="button"
        className="pagetollm-summary-topic"
        style={{ '--pagetollm-card-accent': card.accent }}
        onClick={() => onOpen(card)}
      >
        <HierarchicalCardTitle
          className="pagetollm-summary-topic-title"
          name={card.name}
          path={card.path}
        />
      </button>
      {topicActions.length > 0 && (
        <TopicActionsMenu
          actions={topicActions}
          topic={topicForCard(card)}
          classPrefix="pagetollm"
        />
      )}
    </div>
  );
}

/**
 * Hold the preceding summary in gaps between card boxes.
 * @param {Array<{id: string, box: {top: number}}>} cards Cards in document order.
 * @param {string|null} activeCardId Card whose box contains the cursor, if any.
 * @param {number} cursorY Cursor position in card-box space.
 * @returns {number} Index of the card to show, or -1 above the first card.
 */
function resolveDisplayIndex(cards, activeCardId, cursorY) {
  const activeIndex = cards.findIndex((card) => card.id === activeCardId);
  if (activeIndex >= 0) return activeIndex;
  const nextIndex = cards.findIndex((card) => card.box.top > cursorY);
  return (nextIndex < 0 ? cards.length : nextIndex) - 1;
}

function SummaryCursorView({
  cards,
  topicActions,
  bodyRef,
  scrollContainer,
  scrollWindow,
  isNestedScroll,
  projectedScrollContainerTop,
  onHighlightCard,
  onScrollToCard,
}) {
  const [activeCardId, setActiveCardId] = useState(null);
  const [hoveredCardId, setHoveredCardId] = useState(null);
  // The index changes only at topic boundaries, avoiding scroll renders.
  const [displayIndex, setDisplayIndex] = useState(-1);
  const [enterDirection, setEnterDirection] = useState('down');
  const activeIndexRef = useRef(-1);
  // Same-value setters may still commit after a transition.
  const activeCardIdRef = useRef(null);
  const cardsRef = useRef(cards);
  useEffect(() => {
    cardsRef.current = cards;
  }, [cards]);
  const onHighlightCardRef = useRef(onHighlightCard);
  useEffect(() => {
    onHighlightCardRef.current = onHighlightCard;
  }, [onHighlightCard]);

  // Sorted cards give preceding and following topics around the shown one.
  const { activeCard, cardsBefore, cardsAfter } = useMemo(() => {
    // Clamp: on a level switch `cards` changes before the next cursor update.
    const index = Math.min(displayIndex, cards.length - 1);
    if (index < 0) return { activeCard: null, cardsBefore: [], cardsAfter: cards };
    return {
      activeCard: cards[index],
      cardsBefore: cards.slice(0, index),
      cardsAfter: cards.slice(index + 1),
    };
  }, [cards, displayIndex]);

  // Clear the page highlight in gaps, even while the summary stays visible.
  const highlightCard = useMemo(
    () => cards.find((card) => card.id === activeCardId) || null,
    [activeCardId, cards],
  );

  const updateActiveCard = useCallback(() => {
    const body = bodyRef.current;
    const currentCards = cardsRef.current;
    if (!body || currentCards.length === 0) {
      body?.style.setProperty('--pagetollm-summary-cursor-top', `${SUMMARY_CURSOR_MIN_TOP}px`);
      activeIndexRef.current = -1;
      activeCardIdRef.current = null;
      setHoveredCardId(null);
      setDisplayIndex(-1);
      setActiveCardId(null);
      return;
    }

    const nextState = computeSummaryCursorState({
      cards: currentCards,
      bodyTop: body.getBoundingClientRect().top,
      containerTop: getScrollContainerViewportTop(scrollContainer, scrollWindow),
      containerHeight: getScrollContainerViewportHeight(scrollContainer, scrollWindow),
      scrollTop: getEffectiveScrollOffset({
        scrollContainer,
        scrollWindow,
        isNestedScroll,
        projectedScrollContainerTop,
      }),
      remainingScroll: getRemainingScroll(scrollContainer, scrollWindow),
    });
    // Both cursor elements inherit this value; pixel movement needs no React commit.
    const cursorTop = `${nextState.cursorTop}px`;
    if (body.style.getPropertyValue('--pagetollm-summary-cursor-top') !== cursorTop) {
      body.style.setProperty('--pagetollm-summary-cursor-top', cursorTop);
    }
    const nextIndex = resolveDisplayIndex(
      currentCards,
      nextState.activeCardId,
      nextState.relativeY,
    );
    if (nextIndex !== activeIndexRef.current) {
      // Slide the incoming summary in the scroll direction.
      if (nextIndex >= 0) {
        setEnterDirection(nextIndex > activeIndexRef.current ? 'down' : 'up');
      }
      activeIndexRef.current = nextIndex;
      setDisplayIndex(nextIndex);
      // Clear hover when scrolling moves a title without firing mouseleave.
      setHoveredCardId(null);
    }
    if (nextState.activeCardId !== activeCardIdRef.current) {
      activeCardIdRef.current = nextState.activeCardId;
      setActiveCardId(nextState.activeCardId);
    }
  }, [bodyRef, isNestedScroll, projectedScrollContainerTop, scrollContainer, scrollWindow]);

  useEffect(() => {
    let frameId = 0;
    const scheduleUpdate = () => {
      if (frameId) return;
      frameId = scrollWindow.requestAnimationFrame(() => {
        frameId = 0;
        updateActiveCard();
      });
    };

    updateActiveCard();
    const target = scrollContainer || scrollWindow;
    target.addEventListener('scroll', scheduleUpdate, { passive: true });
    if (target !== scrollWindow) {
      scrollWindow.addEventListener('scroll', scheduleUpdate, { passive: true });
    }
    scrollWindow.addEventListener('resize', scheduleUpdate);
    return () => {
      if (frameId) scrollWindow.cancelAnimationFrame(frameId);
      target.removeEventListener('scroll', scheduleUpdate);
      if (target !== scrollWindow) {
        scrollWindow.removeEventListener('scroll', scheduleUpdate);
      }
      scrollWindow.removeEventListener('resize', scheduleUpdate);
    };
  }, [updateActiveCard, scrollContainer, scrollWindow]);

  useEffect(() => {
    updateActiveCard();
  }, [cards, updateActiveCard]);

  useEffect(() => {
    const highlightFn = onHighlightCardRef.current;
    if (highlightCard) {
      highlightFn(highlightCard, true);
    }
    return () => {
      if (highlightCard) {
        highlightFn(highlightCard, false);
      }
    };
  }, [highlightCard]);

  const hoveredCard = useMemo(
    () => cards.find((card) => card.id === hoveredCardId) || null,
    [cards, hoveredCardId],
  );

  // Card identity clears hover highlights when a title scrolls out of view.
  useEffect(() => {
    if (!hoveredCard) return undefined;
    const highlightFn = onHighlightCardRef.current;
    highlightFn(hoveredCard, true);
    return () => highlightFn(hoveredCard, false);
  }, [hoveredCard]);

  const handleTopicEnter = useCallback((card) => setHoveredCardId(card.id), []);
  const handleTopicLeave = useCallback(
    (card) => setHoveredCardId((prev) => (prev === card.id ? null : prev)),
    [],
  );

  return (
    <>
      <div className="pagetollm-summary-cursor-line" aria-hidden="true" />
      <div className="pagetollm-summary-cursor-hitbox" />
      {cards.length > 0 ? (
        <div className="pagetollm-summary-stack">
          <div className="pagetollm-summary-topic-list is-before">
            {cardsBefore.map((card) => (
              <SummaryTopicTitle
                key={card.id}
                card={card}
                topicActions={topicActions}
                onEnter={handleTopicEnter}
                onLeave={handleTopicLeave}
                onOpen={onScrollToCard}
              />
            ))}
          </div>
          {activeCard ? (
            <div
              key={activeCard.id}
              className={`pagetollm-summary-card-wrap is-enter-${enterDirection}`}
            >
              <button
                type="button"
                className={`pagetollm-summary-active-card is-enter-${enterDirection}`}
                style={{ '--pagetollm-card-accent': activeCard.accent }}
                onClick={() => onScrollToCard(activeCard)}
              >
                <HierarchicalCardTitle
                  className="pagetollm-summary-active-card-title"
                  name={activeCard.name}
                  path={activeCard.path}
                />
                <div className="pagetollm-summary-active-card-body">
                  {activeCard.text || '(no summary)'}
                </div>
              </button>
              {topicActions.length > 0 && (
                <TopicActionsMenu
                  actions={topicActions}
                  topic={topicForCard(activeCard)}
                  classPrefix="pagetollm"
                />
              )}
            </div>
          ) : null}
          <div className="pagetollm-summary-topic-list is-after">
            {cardsAfter.map((card) => (
              <SummaryTopicTitle
                key={card.id}
                card={card}
                topicActions={topicActions}
                onEnter={handleTopicEnter}
                onLeave={handleTopicLeave}
                onOpen={onScrollToCard}
              />
            ))}
          </div>
        </div>
      ) : null}
    </>
  );
}

export default function InPageRail({
  mode,
  maxLevel,
  selectedLevel,
  cards,
  topicActions = [],
  onClose,
  onSelectMode,
  onSelectLevel,
  topicLayout = 'notes',
  onSelectTopicLayout,
  onHighlightCard,
  onScrollToCard,
  scrollContainer,
  scrollWindow = window,
  isNestedScroll = Boolean(scrollContainer && scrollContainer !== scrollWindow),
  projectedScrollContainerTop = isNestedScroll ? scrollContainer.getBoundingClientRect().top : 0,
  railOriginTop = 0,
  summariesDisabled = false,
  sentences = [],
  onChatHighlight,
  onClearChatHighlights,
  recordKey,
  contentRevision,
}) {
  const [frontCardId, setFrontCardId] = useState(null);
  const [chatActionsTarget, setChatActionsTarget] = useState(null);
  const bodyRef = useRef(null);
  const trackRef = useRef(null);
  const isSummary = mode === 'summaries';
  const isChat = mode === 'chat';
  const isNotes = topicLayout !== 'cards';
  const showSummariesDisabledNotice = isSummary && summariesDisabled;

  // Translate content-space card boxes by scroll offset to align with sentences
  // while the rail body stays fixed in the viewport.
  useLayoutEffect(() => {
    if (isSummary || isChat) return undefined;
    const target = scrollContainer || scrollWindow;
    let frameId = 0;
    let lastOffsetValue = null;
    const updateScrollOffset = () => {
      frameId = 0;
      const track = trackRef.current;
      if (!track) return;
      const effectiveScrollOffset = getEffectiveScrollOffset({
        scrollContainer,
        scrollWindow,
        isNestedScroll,
        projectedScrollContainerTop,
      });

      track.style.transform = `translateY(${-effectiveScrollOffset}px)`;
      // Sticky titles need this value because the rail itself does not scroll.
      const offsetValue = `${effectiveScrollOffset}px`;
      if (offsetValue !== lastOffsetValue) {
        lastOffsetValue = offsetValue;
        track.style.setProperty('--pagetollm-scroll-offset', offsetValue);
      }
    };
    const scheduleUpdate = () => {
      if (frameId) return;
      frameId = scrollWindow.requestAnimationFrame(updateScrollOffset);
    };

    updateScrollOffset();
    target.addEventListener('scroll', scheduleUpdate, { passive: true });
    if (target !== scrollWindow) {
      scrollWindow.addEventListener('scroll', scheduleUpdate, { passive: true });
    }
    return () => {
      if (frameId) scrollWindow.cancelAnimationFrame(frameId);
      target.removeEventListener('scroll', scheduleUpdate);
      if (target !== scrollWindow) {
        scrollWindow.removeEventListener('scroll', scheduleUpdate);
      }
    };
  }, [
    isChat,
    isNestedScroll,
    // Switching topic layout swaps the track element, which needs its offset.
    isNotes,
    isSummary,
    projectedScrollContainerTop,
    scrollContainer,
    scrollWindow,
  ]);

  // Recomputed on every render: the controller re-renders on viewport resize,
  // which is the only thing besides the cards that moves the column.
  const noteColumn = computeNoteColumn(cards, getViewportWidth(scrollWindow));

  // Notes are measured once rendered, then spread out so none overlaps another.
  useLayoutEffect(() => {
    if (isSummary || isChat || !isNotes || !trackRef.current) return;
    layoutNotes(trackRef.current, cards);
  }, [cards, isChat, isNotes, isSummary, noteColumn.noteWidth]);

  const bringForward = useCallback((card) => setFrontCardId(card.id), []);

  // Focus can reach offscreen notes and cards; scroll the article to show them.
  const handleCardFocus = useCallback(
    (card, element) => {
      bringForward(card);
      // No element: a pointer press, which is already scrolling on its own.
      if (!element) return;
      const bounds =
        isNotes || !bodyRef.current
          ? { top: 0, bottom: scrollWindow.innerHeight }
          : bodyRef.current.getBoundingClientRect();
      const cardRect = element.getBoundingClientRect();
      const isOnScreen = cardRect.bottom > bounds.top && cardRect.top < bounds.bottom;
      if (isOnScreen) return;
      onScrollToCard(card);
    },
    [bringForward, isNotes, onScrollToCard, scrollWindow],
  );

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

  // Seed the first commit before passive cursor updates; React also removes
  // the property when leaving summaries, so a later mount starts cleanly.
  const bodyStyle = isSummary
    ? { '--pagetollm-summary-cursor-top': `${SUMMARY_CURSOR_MIN_TOP}px` }
    : undefined;

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
        topicLayout={topicLayout}
        onSelectTopicLayout={onSelectTopicLayout}
      />
      <div
        className={isChat ? 'pagetollm-rail-body is-chat' : 'pagetollm-rail-body'}
        ref={bodyRef}
        style={bodyStyle}
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
          />
        ) : showSummariesDisabledNotice ? (
          SUMMARIES_DISABLED_NOTICE
        ) : isSummary ? (
          <SummaryCursorView
            cards={cards}
            topicActions={topicActions}
            bodyRef={bodyRef}
            scrollContainer={scrollContainer}
            scrollWindow={scrollWindow}
            isNestedScroll={isNestedScroll}
            projectedScrollContainerTop={projectedScrollContainerTop}
            onHighlightCard={onHighlightCard}
            onScrollToCard={onScrollToCard}
          />
        ) : !isNotes ? (
          // Distinct keys prevent the card track's transform reaching the notes layer.
          <div key="cards" className="pagetollm-rail-track" ref={trackRef}>
            {cards.map((card) => (
              <MemoizedTopicCard
                key={card.id}
                card={card}
                topicActions={topicActions}
                isFront={frontCardId === card.id}
                onEnter={handleCardEnter}
                onLeave={handleCardLeave}
                onFocus={handleCardFocus}
                onOpen={handleCardOpen}
              />
            ))}
          </div>
        ) : (
          <div
            key="notes"
            className="pagetollm-notes-layer"
            style={{
              '--pagetollm-notes-origin': `${railOriginTop}px`,
              '--pagetollm-notes-left': `${noteColumn.left}px`,
              '--pagetollm-note-width': `${noteColumn.noteWidth}px`,
            }}
          >
            <div className="pagetollm-rail-track" ref={trackRef}>
              {cards.map((card) => (
                <MemoizedRailCard
                  key={card.id}
                  card={card}
                  topicActions={topicActions}
                  isFront={frontCardId === card.id}
                  onEnter={handleCardEnter}
                  onLeave={handleCardLeave}
                  onFocus={handleCardFocus}
                  onOpen={handleCardOpen}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
