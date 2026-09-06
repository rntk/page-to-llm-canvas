import React from 'react';
import { splitTopicPath } from '../../../shared/runtime/topicPath.js';

const RAIL_MODES = [
  ['topics', 'Topics'],
  ['summaries', 'Summaries'],
  ['chat', 'Chat'],
];

function RailModeSelect({ mode, onSelectMode }) {
  const activeMode = RAIL_MODES.some(([value]) => value === mode) ? mode : RAIL_MODES[0][0];

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
 * Shared rail header: mode select, then either the chat-action portal target
 * or the level switcher, then the close button. Both rails render this same
 * structure.
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
}) {
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
