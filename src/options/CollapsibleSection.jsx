import React from 'react';

/**
 * Foldable section built on native <details>/<summary> — accessible and
 * keyboard-toggleable with no JS state. Defaults to open so existing content
 * stays visible; pass `defaultOpen={false}` for sections that should start
 * collapsed to declutter a busy panel.
 *
 * `variant="section"` renders a top-level metrics section (h2 heading).
 * `variant="field"` renders a lighter, nested group (used for the sub-tables
 * inside a section), matching the plain `.field` / `.note--stacked` styling.
 *
 * @param {{
 *   title: React.ReactNode,
 *   defaultOpen?: boolean,
 *   variant?: 'section' | 'field',
 *   children: React.ReactNode,
 * }} props
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
