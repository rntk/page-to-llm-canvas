import React from 'react';
import { groupColorHex } from './projectColors.js';
import { UNTITLED_PROJECT } from './projectText.js';

/**
 * @param {object} props
 * @param {{title?: string, color?: string}} props.project
 * @param {boolean} props.isOpen
 * @param {number} props.tabCount
 * @param {boolean} props.chatOpen
 * @param {function(): void} props.onToggleChat
 */
export function ProjectHeader({ project, isOpen, tabCount, chatOpen, onToggleChat }) {
  return (
    <header className="project-header">
      <span
        className="color-chip"
        style={{ background: groupColorHex(project.color) }}
        title={project.color || 'grey'}
        data-color={project.color || 'grey'}
      />
      <h1>{project.title || UNTITLED_PROJECT}</h1>
      <span className="project-meta">
        {tabCount} {tabCount === 1 ? 'tab' : 'tabs'}
      </span>
      <span className={`status${isOpen ? ' done' : ''}`}>{isOpen ? 'Open' : 'Closed'}</span>
      <span className="project-header-spacer" />
      <button type="button" onClick={onToggleChat} aria-pressed={chatOpen}>
        Chat
      </button>
    </header>
  );
}
