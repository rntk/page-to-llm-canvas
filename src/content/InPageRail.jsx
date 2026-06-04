import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';

const SUMMARY_CURSOR_VIEWPORT_RATIO = 0.38;
const SUMMARY_CURSOR_MIN_TOP = 112;

function ModeDropdown({ mode, recordKey, onSelectMode }) {
  const [isOpen, setIsOpen] = useState(false);
  const menuId = `pagetollm-dropdown-menu-${recordKey}`;
  const label = mode === 'summaries' ? 'Summaries' : 'Topics';

  useEffect(() => {
    if (!isOpen) return undefined;
    const onDocumentClick = () => setIsOpen(false);
    document.addEventListener('click', onDocumentClick);
    return () => document.removeEventListener('click', onDocumentClick);
  }, [isOpen]);

  const onKeyDown = (event) => {
    const items = Array.from(event.currentTarget.querySelectorAll('.pagetollm-rail-dropdown-item'));
    const activeIndex = items.indexOf(document.activeElement);
    switch (event.key) {
      case 'Escape':
        if (isOpen) {
          event.preventDefault();
          setIsOpen(false);
          event.currentTarget.querySelector('.pagetollm-rail-dropdown-toggle')?.focus();
        }
        break;
      case 'ArrowDown': {
        event.preventDefault();
        setIsOpen(true);
        const nextIndex = activeIndex >= 0 ? (activeIndex + 1) % items.length : 0;
        items[nextIndex]?.focus();
        break;
      }
      case 'ArrowUp':
        if (isOpen) {
          event.preventDefault();
          const nextIndex =
            activeIndex >= 0 ? (activeIndex - 1 + items.length) % items.length : items.length - 1;
          items[nextIndex]?.focus();
        }
        break;
      case 'Home':
        if (isOpen) {
          event.preventDefault();
          items[0]?.focus();
        }
        break;
      case 'End':
        if (isOpen) {
          event.preventDefault();
          items[items.length - 1]?.focus();
        }
        break;
    }
  };

  const chooseMode = (nextMode) => {
    setIsOpen(false);
    onSelectMode(nextMode);
  };

  return (
    <div
      className={`pagetollm-rail-dropdown-container${isOpen ? ' open' : ''}`}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={onKeyDown}
    >
      <button
        type="button"
        className="pagetollm-rail-dropdown-toggle pagetollm-rail-title"
        aria-haspopup="true"
        aria-expanded={isOpen}
        aria-controls={menuId}
        onClick={() => setIsOpen((value) => !value)}
      >
        <span className="pagetollm-rail-dropdown-label">{label}</span>
        <span className="pagetollm-rail-dropdown-arrow" aria-hidden="true">
          ▾
        </span>
      </button>
      <div id={menuId} className="pagetollm-rail-dropdown-menu" role="menu">
        {[
          ['topics', 'Topics'],
          ['summaries', 'Summaries'],
          ['hierarchy', 'Hierarchy view'],
          ['canvas', 'Canvas view'],
        ].map(([itemMode, text]) => (
          <button
            key={itemMode}
            type="button"
            className={`pagetollm-rail-dropdown-item${
              mode === itemMode && itemMode !== 'canvas' && itemMode !== 'hierarchy'
                ? ' active'
                : ''
            }`}
            role="menuitem"
            data-mode={itemMode}
            onClick={() => chooseMode(itemMode)}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
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
    borderColor: card.accent,
    '--pagetollm-card-accent': card.accent,
  };
  if (isSummary) {
    style.height = `${card.box.height}px`;
  } else {
    style.minHeight = `${card.box.height}px`;
  }

  return (
    <button
      type="button"
      className={['pagetollm-rail-card', isSummary ? 'is-summary' : '', isFront ? 'is-front' : '']
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

function getCursorRelativeY(scrollContainer, body, cursorTop) {
  const bodyTop = body.getBoundingClientRect().top;
  if (!scrollContainer || scrollContainer === window) {
    return cursorTop - bodyTop;
  }
  return scrollContainer.scrollTop + cursorTop - bodyTop;
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

    const containerTop = getScrollContainerViewportTop(scrollContainer);
    const containerHeight = getScrollContainerViewportHeight(scrollContainer);
    const nextCursorTop = Math.max(
      SUMMARY_CURSOR_MIN_TOP,
      Math.round(containerTop + containerHeight * SUMMARY_CURSOR_VIEWPORT_RATIO),
    );
    setCursorTop(nextCursorTop);

    const relativeY = getCursorRelativeY(scrollContainer, body, nextCursorTop);
    const matching = currentCards
      .filter((card) => relativeY >= card.box.top && relativeY <= card.box.top + card.box.height)
      .sort((a, b) => a.box.height - b.box.height || a.box.top - b.box.top);

    setActiveCardId(matching[0]?.id || null);
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
  recordKey,
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
}) {
  const [frontCardId, setFrontCardId] = useState(null);
  const [scrollOffset, setScrollOffset] = useState(() => getScrollContainerTop(scrollContainer));
  const bodyRef = useRef(null);
  const isSummary = mode === 'summaries';
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
  };

  return (
    <>
      <div className="pagetollm-rail-head">
        <ModeDropdown mode={mode} recordKey={recordKey} onSelectMode={onSelectMode} />
        <LevelSwitcher
          maxLevel={maxLevel}
          selectedLevel={selectedLevel}
          onSelectLevel={onSelectLevel}
        />
        <button className="pagetollm-rail-close" type="button" title="Close rail" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="pagetollm-rail-body" ref={bodyRef} style={bodyStyle}>
        {isSummary ? (
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
