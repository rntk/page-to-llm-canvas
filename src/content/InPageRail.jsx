import React, { useEffect, useMemo, useState } from "react";

function ModeDropdown({ mode, recordKey, onSelectMode }) {
  const [isOpen, setIsOpen] = useState(false);
  const menuId = `pagetollm-dropdown-menu-${recordKey}`;
  const label = mode === "summaries" ? "Summaries" : "Topics";

  useEffect(() => {
    if (!isOpen) return undefined;
    const onDocumentClick = () => setIsOpen(false);
    document.addEventListener("click", onDocumentClick);
    return () => document.removeEventListener("click", onDocumentClick);
  }, [isOpen]);

  const onKeyDown = (event) => {
    const items = Array.from(
      event.currentTarget.querySelectorAll(".pagetollm-rail-dropdown-item"),
    );
    const activeIndex = items.indexOf(document.activeElement);
    switch (event.key) {
      case "Escape":
        if (isOpen) {
          event.preventDefault();
          setIsOpen(false);
          event.currentTarget
            .querySelector(".pagetollm-rail-dropdown-toggle")
            ?.focus();
        }
        break;
      case "ArrowDown": {
        event.preventDefault();
        setIsOpen(true);
        const nextIndex = activeIndex >= 0 ? (activeIndex + 1) % items.length : 0;
        items[nextIndex]?.focus();
        break;
      }
      case "ArrowUp":
        if (isOpen) {
          event.preventDefault();
          const nextIndex = activeIndex >= 0
            ? (activeIndex - 1 + items.length) % items.length
            : items.length - 1;
          items[nextIndex]?.focus();
        }
        break;
      case "Home":
        if (isOpen) {
          event.preventDefault();
          items[0]?.focus();
        }
        break;
      case "End":
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
      className={`pagetollm-rail-dropdown-container${isOpen ? " open" : ""}`}
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
        <span className="pagetollm-rail-dropdown-arrow" aria-hidden="true">▾</span>
      </button>
      <div id={menuId} className="pagetollm-rail-dropdown-menu" role="menu">
        {[
          ["topics", "Topics"],
          ["summaries", "Summaries"],
          ["canvas", "Canvas view"],
        ].map(([itemMode, text]) => (
          <button
            key={itemMode}
            type="button"
            className={`pagetollm-rail-dropdown-item${
              mode === itemMode && itemMode !== "canvas" ? " active" : ""
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
            className={`pagetollm-rail-level-btn${selectedLevel === level ? " active" : ""}`}
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
    "--pagetollm-card-accent": card.accent,
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
        "pagetollm-rail-card",
        isSummary ? "is-summary" : "",
        isFront ? "is-front" : "",
      ].filter(Boolean).join(" ")}
      style={style}
      onMouseEnter={() => onEnter(card)}
      onMouseLeave={() => onLeave(card)}
      onFocus={() => onFocus(card)}
      onPointerDown={() => onFocus(card)}
      onClick={() => onOpen(card)}
    >
      <div className="pagetollm-rail-card-content">
        <div className="pagetollm-rail-card-title" title={card.path}>
          {card.name}
        </div>
        {isSummary ? (
          <div className="pagetollm-rail-card-body">{card.text || "(no summary)"}</div>
        ) : (
          <div className="pagetollm-rail-card-meta">{card.sentences.length} sent.</div>
        )}
      </div>
    </button>
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
}) {
  const [frontCardId, setFrontCardId] = useState(null);
  const isSummary = mode === "summaries";
  const normalizedHeight = useMemo(() => `${bodyHeight}px`, [bodyHeight]);

  const bringForward = (card) => setFrontCardId(card.id);

  return (
    <>
      <div className="pagetollm-rail-head">
        <ModeDropdown mode={mode} recordKey={recordKey} onSelectMode={onSelectMode} />
        <LevelSwitcher
          maxLevel={maxLevel}
          selectedLevel={selectedLevel}
          onSelectLevel={onSelectLevel}
        />
        <button
          className="pagetollm-rail-close"
          type="button"
          title="Close rail"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <div className="pagetollm-rail-body" style={{ height: normalizedHeight }}>
        {cards.map((card) => (
          <RailCard
            key={card.id}
            card={card}
            isSummary={isSummary}
            isFront={frontCardId === card.id}
            onEnter={(nextCard) => {
              bringForward(nextCard);
              onHighlightCard(nextCard, true);
            }}
            onLeave={(nextCard) => onHighlightCard(nextCard, false)}
            onFocus={bringForward}
            onOpen={(nextCard) => {
              bringForward(nextCard);
              onScrollToCard(nextCard);
            }}
          />
        ))}
      </div>
    </>
  );
}
