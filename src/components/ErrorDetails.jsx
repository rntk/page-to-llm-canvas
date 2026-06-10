import React from 'react';

/**
 * Reusable component to render a primary error message and an optional,
 * collapsible stack trace/technical details preformatted block.
 *
 * @param {{
 *   message: string,
 *   details?: string,
 *   msgClassName?: string,
 *   detailsClassName?: string,
 * }} props
 */
export default function ErrorDetails({ message, details, msgClassName, detailsClassName }) {
  if (!details) {
    return <div className={msgClassName}>{message}</div>;
  }

  return (
    <>
      <div className={msgClassName}>{message}</div>
      <details className={detailsClassName}>
        <summary>Technical details</summary>
        <pre>{details}</pre>
      </details>
    </>
  );
}
