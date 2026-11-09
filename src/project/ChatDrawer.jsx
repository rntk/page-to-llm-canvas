import React from 'react';

/**
 * The shell of a chat unfolded beside a canvas card: a labelled aside with one
 * header row (the label, then the chat's own History/New actions portalled
 * into `actionsRef`) and the chat body.
 *
 * @param {object} props
 * @param {string} [props.id] Lets the card's fold button reference the drawer.
 * @param {string} props.label Header text.
 * @param {string} props.ariaLabel
 * @param {function(?HTMLElement): void} [props.actionsRef] Receives the header
 *   actions slot, for ArticleChat's `headerActionsTarget`.
 * @param {React.ReactNode} props.children
 */
export function ChatDrawer({ id, label, ariaLabel, actionsRef, children }) {
  return (
    <aside
      id={id}
      className="page-chat-drawer"
      data-canvas-chat=""
      data-canvas-scroll=""
      aria-label={ariaLabel}
    >
      <header className="page-chat-header">
        <span className="page-chat-label">{label}</span>
        {actionsRef && <span className="page-chat-actions" ref={actionsRef} />}
      </header>
      <div className="page-chat-body">{children}</div>
    </aside>
  );
}
