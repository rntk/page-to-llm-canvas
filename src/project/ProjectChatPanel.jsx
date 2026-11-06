import React from 'react';

/**
 * Collapsible global chat stub (visual only).
 *
 * @param {object} props
 * @param {function(): void} props.onCollapse
 */
export function ProjectChatPanel({ onCollapse }) {
  return (
    <aside className="chat-panel" aria-label="Project chat">
      <header className="chat-panel-header">
        <h2>Project chat</h2>
        <button type="button" onClick={onCollapse} aria-label="Collapse project chat">
          Hide
        </button>
      </header>
      <div className="chat-panel-body">
        <p className="note">Coming soon — chat across all pages in this project</p>
      </div>
      <form className="chat-panel-composer" onSubmit={(event) => event.preventDefault()}>
        <textarea disabled rows={3} placeholder="Ask about this project…" aria-label="Message" />
        <button type="submit" disabled>
          Send
        </button>
      </form>
    </aside>
  );
}
