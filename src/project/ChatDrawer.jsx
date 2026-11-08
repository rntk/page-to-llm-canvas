import React from 'react';

/**
 * The shell of a chat unfolded beside a canvas card: a labelled aside with a
 * small header and the chat body.
 *
 * @param {object} props
 * @param {string} props.label Header text.
 * @param {string} props.ariaLabel
 * @param {React.ReactNode} props.children
 */
export function ChatDrawer({ label, ariaLabel, children }) {
  return (
    <aside className="page-chat-drawer" aria-label={ariaLabel}>
      <header className="page-chat-header">
        <span className="page-chat-label">{label}</span>
      </header>
      <div className="page-chat-body">{children}</div>
    </aside>
  );
}
