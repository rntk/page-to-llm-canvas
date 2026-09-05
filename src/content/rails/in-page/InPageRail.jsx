import React, { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback } from 'react';
import { computeSummaryCursorState, SUMMARY_CURSOR_MIN_TOP } from './summaryCursor.js';
import ArticleChat from '../../../chat/ArticleChat.jsx';
import { HierarchicalCardTitle, RailHead } from '../shared/RailControls.jsx';

const IN_PAGE_RAIL_MODES = [
  ['hierarchy', 'Hierarchy view'],
  ['canvas', 'Canvas view'],
];

const SUMMARIES_DISABLED_NOTICE = (
  <div className="pagetollm-rail-empty">
    Summaries are disabled. Enable them in the extension settings and reprocess this page to see
    them here.
  </div>
);

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
        <HierarchicalCardTitle
          className="pagetollm-rail-card-title"
          name={card.name}
          path={card.path}
        />
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

function SummaryTopicTitle({ card, onEnter, onLeave, onOpen }) {
  return (
    <button
      type="button"
      className="pagetollm-summary-topic"
      style={{ '--pagetollm-card-accent': card.accent }}
      onMouseEnter={() => onEnter(card)}
      onMouseLeave={() => onLeave(card)}
      onClick={() => onOpen(card)}
    >
      <HierarchicalCardTitle
        className="pagetollm-summary-topic-title"
        name={card.name}
        path={card.path}
      />
    </button>
  );
}

/**
 * Index of the summary to show for the current cursor position. In the gaps
 * between card boxes the cursor has no active card, so we hold the nearest one
 * above it: the summary stays put instead of blanking out at every boundary.
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
  bodyRef,
  bodyHeight,
  scrollContainer,
  scrollWindow,
  isNestedScroll,
  projectedScrollContainerTop,
  onHighlightCard,
  onScrollToCard,
}) {
  const [activeCardId, setActiveCardId] = useState(null);
  const [hoveredCardId, setHoveredCardId] = useState(null);
  // Index rather than the raw cursor position: it only changes at topic
  // boundaries, so scrolling within a topic causes no re-render at all.
  const [displayIndex, setDisplayIndex] = useState(-1);
  const [enterDirection, setEnterDirection] = useState('down');
  const activeIndexRef = useRef(-1);
  // Guard repeated scroll writes explicitly: same-value setters can still
  // produce a follow-up commit after a transition (covered by the Profiler test).
  const activeCardIdRef = useRef(null);
  const cardsRef = useRef(cards);
  useEffect(() => {
    cardsRef.current = cards;
  }, [cards]);
  const onHighlightCardRef = useRef(onHighlightCard);
  useEffect(() => {
    onHighlightCardRef.current = onHighlightCard;
  }, [onHighlightCard]);

  // Cards arrive sorted by vertical position, so the slices around the shown
  // one are the topics that precede and follow it in the article.
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

  // The page highlight follows the strictly-active card, so it clears in the
  // gaps between topics even though the summary card itself stays put.
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
      isWindowScroll: !scrollContainer || scrollContainer === scrollWindow,
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
      // Slide the incoming summary in from the side it arrives from, so the
      // swap reads as movement through the article rather than a jump cut.
      if (nextIndex >= 0) {
        setEnterDirection(nextIndex > activeIndexRef.current ? 'down' : 'up');
      }
      activeIndexRef.current = nextIndex;
      setDisplayIndex(nextIndex);
      // A hovered title moves into the card slot as the page scrolls, which
      // never fires mouseleave; drop the hover so its highlight can't stick.
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

  // Hovering a neighbouring title highlights its sentences. Keying the effect on
  // the card (not the DOM event) also clears the highlight when the hovered card
  // scrolls out of the list without ever firing a mouseleave.
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
      <div className="pagetollm-summary-cursor-hitbox" style={{ height: `${bodyHeight}px` }} />
      {cards.length > 0 ? (
        <div className="pagetollm-summary-stack">
          <div className="pagetollm-summary-topic-list is-before">
            {cardsBefore.map((card) => (
              <SummaryTopicTitle
                key={card.id}
                card={card}
                onEnter={handleTopicEnter}
                onLeave={handleTopicLeave}
                onOpen={onScrollToCard}
              />
            ))}
          </div>
          {activeCard ? (
            <button
              key={activeCard.id}
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
          ) : null}
          <div className="pagetollm-summary-topic-list is-after">
            {cardsAfter.map((card) => (
              <SummaryTopicTitle
                key={card.id}
                card={card}
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
  bodyHeight,
  onClose,
  onSelectMode,
  onSelectLevel,
  onHighlightCard,
  onScrollToCard,
  scrollContainer,
  scrollWindow = window,
  isNestedScroll = Boolean(scrollContainer && scrollContainer !== scrollWindow),
  projectedScrollContainerTop = isNestedScroll ? scrollContainer.getBoundingClientRect().top : 0,
  summariesDisabled = false,
  sentences = [],
  onChatHighlight,
  onClearChatHighlights,
  recordKey,
}) {
  const [frontCardId, setFrontCardId] = useState(null);
  const [chatActionsTarget, setChatActionsTarget] = useState(null);
  const bodyRef = useRef(null);
  const isSummary = mode === 'summaries';
  const isChat = mode === 'chat';
  const showSummariesDisabledNotice = isSummary && summariesDisabled;

  useLayoutEffect(() => {
    const target = scrollContainer || scrollWindow;
    let frameId = 0;
    // Only the nested-scroll topic titles read the offset variable, and writing
    // it invalidates style for the whole rail body subtree. In summaries mode
    // that write is a no-op that would also force a synchronous layout, since
    // SummaryCursorView measures the same body from its own scroll frame.
    const tracksOffset = isNestedScroll && !isSummary;
    let lastOffsetValue = null;
    const updateScrollOffset = () => {
      frameId = 0;
      const effectiveScrollOffset = getEffectiveScrollOffset({
        scrollContainer,
        scrollWindow,
        isNestedScroll,
        projectedScrollContainerTop,
      });

      const body = bodyRef.current;
      if (!body) return;
      // Nested card positions live in the inner scroller's content space. The
      // fixed/clipped host prevents page overflow; this translation still maps
      // those positions back into the viewport as the inner scroller moves.
      body.style.transform = `translateY(${-effectiveScrollOffset}px)`;
      const offsetValue = `${effectiveScrollOffset}px`;
      if (offsetValue !== lastOffsetValue) {
        lastOffsetValue = offsetValue;
        body.style.setProperty('--pagetollm-scroll-offset', offsetValue);
      }
    };
    const scheduleUpdate = () => {
      if (frameId) return;
      frameId = scrollWindow.requestAnimationFrame(updateScrollOffset);
    };

    if (!tracksOffset) {
      const body = bodyRef.current;
      if (body) {
        body.style.transform = '';
        body.style.removeProperty('--pagetollm-scroll-offset');
      }
      return undefined;
    }

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
  }, [isNestedScroll, isSummary, projectedScrollContainerTop, scrollContainer, scrollWindow]);

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
    height: `${bodyHeight}px`,
    // Seed the first commit before passive cursor updates; React also removes
    // the property when leaving summaries, so a later mount starts cleanly.
    ...(isSummary ? { '--pagetollm-summary-cursor-top': `${SUMMARY_CURSOR_MIN_TOP}px` } : {}),
  };

  return (
    <>
      <RailHead
        mode={mode}
        additionalModes={IN_PAGE_RAIL_MODES}
        onSelectMode={onSelectMode}
        isChat={isChat}
        setChatActionsTarget={setChatActionsTarget}
        maxLevel={maxLevel}
        selectedLevel={selectedLevel}
        onSelectLevel={onSelectLevel}
        onClose={onClose}
      />
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
            headerActionsTarget={chatActionsTarget}
          />
        ) : showSummariesDisabledNotice ? (
          SUMMARIES_DISABLED_NOTICE
        ) : isSummary ? (
          <SummaryCursorView
            cards={cards}
            bodyRef={bodyRef}
            bodyHeight={bodyHeight}
            scrollContainer={scrollContainer}
            scrollWindow={scrollWindow}
            isNestedScroll={isNestedScroll}
            projectedScrollContainerTop={projectedScrollContainerTop}
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
