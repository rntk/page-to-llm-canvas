import React from 'react';
import { splitTopicPath } from '../../../shared/runtime/topicPath.js';
import { normalizeRailMode, RAIL_MODES } from './railState.js';

function RailModeSelect({ mode, onSelectMode }) {
  const activeMode = normalizeRailMode(mode);

  return (
    <select
      className="pagetollm-rail-mode-select pagetollm-rail-title"
      aria-label="Rail view"
      value={activeMode}
      onChange={(event) => onSelectMode(event.target.value)}
    >
      {RAIL_MODES.map(([value, label]) => (
        <option key={value} value={value}>
          {label}
        </option>
      ))}
    </select>
  );
}

/**
 * Topics-mode switch between the margin-note layout (drawn on the page) and
 * the classic card column inside the rail, kept as a fallback for pages where
 * notes beside the text are hard to read.
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
 * Shared rail header: mode select, then either the chat-action portal target
 * or the level switcher, then the close button. Both rails render this same
 * structure; only the in-page rail passes `onSelectTopicLayout`, which adds
 * the topic layout toggle in topics mode.
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
}) {
  const showLayoutToggle = Boolean(onSelectTopicLayout) && normalizeRailMode(mode) === 'topics';
  return (
    <div className="pagetollm-rail-head">
      <RailModeSelect mode={mode} onSelectMode={onSelectMode} />
      {isChat ? (
        <div className="pagetollm-rail-chat-actions" ref={setChatActionsTarget} />
      ) : (
        <RailLevelSwitcher
          maxLevel={maxLevel}
          selectedLevel={selectedLevel}
          onSelectLevel={onSelectLevel}
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

function RailLevelSwitcher({ maxLevel, selectedLevel, onSelectLevel }) {
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
