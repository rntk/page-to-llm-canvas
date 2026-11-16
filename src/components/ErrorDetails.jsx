import React from 'react';

/**
 * Error message with an optional collapsible technical details block.
 *
 * @param {object} props
 * @param {string} props.message
 * @param {string} [props.details]
 * @param {string} [props.msgClassName]
 * @param {string} [props.detailsClassName]
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
