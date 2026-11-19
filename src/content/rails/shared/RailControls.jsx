import React, { useEffect, useRef, useState } from 'react';
import { splitTopicPath } from '../../../shared/runtime/topicPath.js';
import { normalizeRailMode, RAIL_MODES } from './railState.js';

/**
 * Fixed-width "sandwich" button that opens a menu of rail views. Replaces a
 * <select> whose label was truncated in the narrow rail.
 */
function RailModeMenu({ mode, onSelectMode }) {
  const activeMode = normalizeRailMode(mode);
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const buttonRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const doc = rootRef.current?.ownerDocument ?? document;
    const handlePointerDown = (event) => {
      const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
      if (rootRef.current && !path.includes(rootRef.current)) setOpen(false);
    };
    const handleKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    doc.addEventListener('pointerdown', handlePointerDown, true);
    doc.addEventListener('keydown', handleKeyDown, true);
    return () => {
      doc.removeEventListener('pointerdown', handlePointerDown, true);
      doc.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [open]);

  const activeLabel = RAIL_MODES.find(([value]) => value === activeMode)?.[1] ?? '';

  return (
    <div className="pagetollm-rail-mode-menu" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="pagetollm-rail-mode-button"
        aria-label="Rail view"
        aria-haspopup="menu"
        aria-expanded={open}
        title={`Rail view: ${activeLabel}`}
        data-mode={activeMode}
        onClick={() => setOpen((value) => !value)}
      >
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
          <path d="M2 3.5h12M2 8h12M2 12.5h12" stroke="currentColor" strokeWidth="1.8" />
        </svg>
      </button>
      {open ? (
        <div className="pagetollm-rail-mode-list" role="menu" aria-label="Rail view">
          {RAIL_MODES.map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="menuitemradio"
              aria-checked={value === activeMode}
              className={['pagetollm-rail-mode-option', value === activeMode ? 'active' : '']
                .filter(Boolean)
                .join(' ')}
              data-mode={value}
              onClick={() => {
                setOpen(false);
                if (value !== activeMode) onSelectMode(value);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Topics-mode switch between margin notes (drawn on the page) and the classic
 * in-rail card column, a fallback for pages where margin notes are hard to read.
 */
function RailTopicLayoutToggle({ topicLayout, onSelectTopicLayout }) {
  const isNotes = topicLayout !== 'cards';
  const label = isNotes ? 'Switch to card view' : 'Switch to margin notes';
  // Dressed as the level switcher so the head reads as one row of controls.
  return (
    <div className="pagetollm-rail-level-switcher">
      <div className="pagetollm-rail-level-buttons">
        <button
          type="button"
          className="pagetollm-rail-level-btn pagetollm-rail-layout-toggle"
          aria-label={label}
          title={label}
          onClick={() => onSelectTopicLayout(isNotes ? 'cards' : 'notes')}
        >
          {isNotes ? 'C' : 'N'}
        </button>
      </div>
    </div>
  );
}

/**
 * Shared rail header: view menu button, chat-action portal target or level switcher,
 * then close button. Only the in-page rail passes `onSelectTopicLayout`, which
 * adds the topic layout toggle in topics mode.
 */
export function RailHead({
  mode,
  onSelectMode,
  isChat,
  setChatActionsTarget,
  maxLevel,
  selectedLevel,
  onSelectLevel,
  onClose,
  topicLayout,
  onSelectTopicLayout,
  suggestedLevel = null,
}) {
  const showLayoutToggle = Boolean(onSelectTopicLayout) && normalizeRailMode(mode) === 'topics';
  return (
    <div className="pagetollm-rail-head">
      <RailModeMenu mode={mode} onSelectMode={onSelectMode} />
      {isChat ? (
        <div className="pagetollm-rail-chat-actions" ref={setChatActionsTarget} />
      ) : (
        <RailLevelSwitcher
          maxLevel={maxLevel}
          selectedLevel={selectedLevel}
          onSelectLevel={onSelectLevel}
          suggestedLevel={suggestedLevel}
        />
      )}
      {showLayoutToggle ? (
        <RailTopicLayoutToggle
          topicLayout={topicLayout}
          onSelectTopicLayout={onSelectTopicLayout}
        />
      ) : null}
      <button
        className="pagetollm-rail-close"
        type="button"
        aria-label="Close rail"
        title="Close rail"
        onClick={onClose}
      >
        ×
      </button>
    </div>
  );
}

function RailLevelSwitcher({ maxLevel, selectedLevel, onSelectLevel, suggestedLevel }) {
  if (maxLevel <= 0) return null;

  return (
    <div className="pagetollm-rail-level-switcher">
      <div className="pagetollm-rail-level-buttons">
        {Array.from({ length: maxLevel + 1 }, (_, level) => {
          const isSuggested = suggestedLevel === level && selectedLevel !== level;
          return (
            <button
              key={level}
              type="button"
              className={[
                'pagetollm-rail-level-btn',
                selectedLevel === level ? 'active' : '',
                isSuggested ? 'is-suggested' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              title={
                isSuggested ? `Level ${level} fits this moment better` : `Switch to level ${level}`
              }
              data-level={level}
              onClick={() => onSelectLevel(level)}
            >
              L{level}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Quiet note under the current card: another level fits this moment better.
 * Renders nothing without a suggestion, so callers can mount it unconditionally.
 */
export function LevelHintNote({ selectedLevel, suggestedLevel, onSelectLevel }) {
  if (suggestedLevel == null || suggestedLevel === selectedLevel) return null;
  const isParent = suggestedLevel < selectedLevel;
  return (
    <button
      type="button"
      className="pagetollm-level-hint"
      data-level={suggestedLevel}
      title={`Switch to level ${suggestedLevel}`}
      onClick={() => onSelectLevel(suggestedLevel)}
    >
      {isParent ? 'Broader' : 'More detail'} on L{suggestedLevel} fits this moment
    </button>
  );
}

export function HierarchicalCardTitle({ name, path, className }) {
  const parts = typeof path === 'string' ? splitTopicPath(path) : [];
  const parentTopics = parts.slice(0, -1);
  const currentTopic = name || parts.at(-1) || '';

  return (
    <span className={className} title={path || currentTopic} lang="en">
      {parentTopics.length > 0 ? (
        <span className="pagetollm-rail-card-parent-topics">{parentTopics.join(' › ')}</span>
      ) : null}
      <span className="pagetollm-rail-card-current-topic">{currentTopic}</span>
    </span>
  );
}
