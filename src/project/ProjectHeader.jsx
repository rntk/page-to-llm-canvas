import React from 'react';
import { groupColorHex } from './projectColors.js';
import { UNTITLED_PROJECT } from './projectText.js';
import { ProjectActionsMenu } from './ProjectActionsMenu.jsx';

/**
 * @param {object} props
 * @param {{title?: string, color?: string}} props.project
 * @param {boolean} props.isOpen
 * @param {number} props.tabCount
 * @param {boolean} props.chatOpen
 * @param {function(): void} props.onToggleChat
 * @param {React.ReactNode} [props.viewTabs] View switcher displayed inside the header.
 * @param {object[]} [props.actions] Project-wide action descriptors.
 */
export function ProjectHeader({
  project,
  isOpen,
  tabCount,
  chatOpen,
  onToggleChat,
  actions,
  viewTabs,
}) {
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
      {viewTabs}
      <span className="project-header-spacer" />
      <button type="button" onClick={onToggleChat} aria-pressed={chatOpen}>
        Chat
      </button>
      <ProjectActionsMenu actions={actions} />
    </header>
  );
}
