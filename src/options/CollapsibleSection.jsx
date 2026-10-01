import React from 'react';

/**
 * Native collapsible section, open by default. The `field` variant renders a
 * nested group; `section` renders an h2.
 *
 * @param {object} props
 * @param {React.ReactNode} props.title
 * @param {boolean} [props.defaultOpen]
 * @param {('section'|'field')} [props.variant]
 * @param {React.ReactNode} props.children
 */
export function CollapsibleSection({ title, defaultOpen = true, variant = 'section', children }) {
  const isField = variant === 'field';
  return (
    <details className={isField ? 'collapsible field' : 'collapsible section'} open={defaultOpen}>
      <summary className="collapsible-summary">
        {isField ? (
          <span className="note note--stacked collapsible-title">{title}</span>
        ) : (
          <h2 className="collapsible-title">{title}</h2>
        )}
      </summary>
      <div className="collapsible-body">{children}</div>
    </details>
  );
}
