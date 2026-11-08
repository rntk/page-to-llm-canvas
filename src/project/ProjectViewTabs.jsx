import React from 'react';

const VIEWS = [
  { id: 'canvas', label: 'Canvas' },
  { id: 'topics', label: 'Topics tree' },
];

/**
 * @param {object} props
 * @param {string} props.activeView
 * @param {function(string): void} props.onSelect
 */
export function ProjectViewTabs({ activeView, onSelect }) {
  return (
    <div className="project-view-tabs" role="tablist" aria-label="Project views">
      {VIEWS.map(({ id, label }) => (
        <button
          key={id}
          type="button"
          role="tab"
          id={`project-tab-${id}`}
          aria-controls={`project-panel-${id}`}
          aria-selected={activeView === id}
          onClick={() => onSelect(id)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
