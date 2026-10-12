import React, { useEffect, useId, useRef, useState } from 'react';

/** Search and select the topics for a new conversation.
 * @param {object} props Dialog properties.
 */
export default function TopicScopeDialog({ paths, scope, onApply, onClose }) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(() => new Set(scope));
  const dialogRef = useRef(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = dialogRef.current;
    // For a shadow-root host, document.activeElement is only the host.
    const previous = dialog.getRootNode().activeElement || dialog.ownerDocument.activeElement;
    dialog.showModal();
    dialog.querySelector('input')?.focus();
    return () => {
      dialog.close();
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  // Only offer existing topics: a missing path re-applied would block the new chat too.
  const choices = paths.filter((path) =>
    path.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  return (
    <dialog
      ref={dialogRef}
      className="pagetollm-chat-scope-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <h2 id={titleId}>Chat topics</h2>
      <p>Changing topics starts a new chat. Select none to use the whole document.</p>
      <input
        type="search"
        aria-label="Search topics"
        placeholder="Search topics…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="pagetollm-chat-scope-options">
        {choices.map((path) => (
          <label key={path}>
            <input
              type="checkbox"
              checked={selected.has(path)}
              onChange={() => {
                setSelected((previous) => {
                  const next = new Set(previous);
                  if (next.has(path)) next.delete(path);
                  else next.add(path);
                  return next;
                });
              }}
            />
            {path}
          </label>
        ))}
        {!choices.length && <p>No matching topics.</p>}
      </div>
      <p>{selected.size ? `${selected.size} topics selected` : 'Whole document'}</p>
      <div className="pagetollm-chat-actions">
        <button type="button" onClick={() => setSelected(new Set())}>
          Clear selection
        </button>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button type="button" onClick={() => onApply([...selected])}>
          Apply
        </button>
      </div>
    </dialog>
  );
}
