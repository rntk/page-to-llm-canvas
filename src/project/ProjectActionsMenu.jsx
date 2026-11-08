import React, { useEffect, useRef } from 'react';

/** A project-wide action list. New actions supply a descriptor rather than header markup. */
export function ProjectActionsMenu({ actions }) {
  const menuRef = useRef(null);
  useEffect(() => {
    const closeOutside = (event) => {
      if (!menuRef.current?.contains(event.target) && menuRef.current) {
        menuRef.current.open = false;
      }
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, []);

  if (!actions?.length) return null;
  return (
    <details
      className="project-actions"
      ref={menuRef}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !menuRef.current.open) return;
        event.stopPropagation();
        menuRef.current.open = false;
        menuRef.current.querySelector('summary')?.focus();
      }}
    >
      <summary>Project actions</summary>
      <div className="project-actions__list" role="group" aria-label="Project actions">
        {actions.map((action) => (
          <button
            key={action.id}
            type="button"
            disabled={action.disabled}
            onClick={() => {
              menuRef.current.open = false;
              action.onSelect();
            }}
          >
            <span>{action.label}</span>
            {action.description && <small>{action.description}</small>}
          </button>
        ))}
      </div>
    </details>
  );
}
