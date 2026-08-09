import React from 'react';

/**
 * Presentational error state shared by expected surface failures and the
 * unexpected-render ErrorBoundary fallback.
 */
export default function SurfaceError({
  message,
  details,
  onRetry,
  retryLabel = 'Try again',
  onDismiss,
  onReload,
}) {
  return (
    <div className="pagetollm-error-boundary" role="alert">
      <p>{message}</p>
      {details ? (
        <details className="pagetollm-error-details">
          <summary>Details</summary>
          <p>{details}</p>
        </details>
      ) : null}
      <p>
        {onRetry ? (
          <button type="button" onClick={onRetry}>
            {retryLabel}
          </button>
        ) : null}{' '}
        {onDismiss ? (
          <button type="button" onClick={onDismiss}>
            Close
          </button>
        ) : onReload ? (
          <button type="button" onClick={onReload}>
            Reload
          </button>
        ) : null}
      </p>
    </div>
  );
}
