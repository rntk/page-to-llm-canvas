import React, { useEffect, useRef, useState } from 'react';

/** A project-wide action menu. New actions supply a descriptor rather than header markup. */
export function ProjectActionsMenu({ actions }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const toggleRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const closeOutside = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [open]);

  useEffect(() => {
    if (open) rootRef.current?.querySelector('[role="menuitem"]:not(:disabled)')?.focus();
  }, [open]);

  if (!actions?.length) return null;

  const moveFocus = (event) => {
    const items = [...rootRef.current.querySelectorAll('[role="menuitem"]:not(:disabled)')];
    if (!items.length) return;
    const index = items.indexOf(document.activeElement);
    const step = event.key === 'ArrowDown' ? 1 : -1;
    items[(index + step + items.length) % items.length].focus();
  };

  return (
    <div
      className="project-actions"
      ref={rootRef}
      onKeyDown={(event) => {
        if (!open) return;
        if (event.key === 'Escape') {
          event.stopPropagation();
          setOpen(false);
          toggleRef.current?.focus();
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          moveFocus(event);
        }
      }}
    >
      <button
        ref={toggleRef}
        type="button"
        className="project-actions__toggle"
        aria-label="Project actions"
        title="Project actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="project-actions__icon" aria-hidden="true" />
      </button>
      {open && (
        <div className="project-actions__list" role="menu" aria-label="Project actions">
          {actions.map((action) => (
            <button
              key={action.id}
              type="button"
              role="menuitem"
              disabled={action.disabled}
              onClick={() => {
                setOpen(false);
                action.onSelect();
              }}
            >
              <span>{action.label}</span>
              {action.description && <small>{action.description}</small>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
