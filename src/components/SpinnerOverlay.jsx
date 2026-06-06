import React from 'react';
import { closeModal } from '../closeModal.js';

/**
 * Shared chrome for every overlay state: a centered box with a title, an
 * optional body line, and an actions row. The default "processing" state is the
 * one exception (it shows a spinner instead of a title) and is rendered inline.
 *
 * @param {{
 *   title: string,
 *   body?: import('react').ReactNode,
 *   onRetry?: () => void,
 * }} props
 */
function OverlayShell({ title, body, onRetry }) {
  return (
    <div className="pagetollm-spinner-overlay" role="alert">
      <div className="pagetollm-spinner-box">
        <div className="pagetollm-spinner-error-title">{title}</div>
        {body && <div className="pagetollm-spinner-error-body">{body}</div>}
        <div className="pagetollm-spinner-actions">
          {onRetry && (
            <button className="pagetollm-spinner-retry-btn" onClick={onRetry}>
              Retry
            </button>
          )}
          <button className="pagetollm-spinner-close-btn" onClick={closeModal}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * @param {{
 *   stage?: string,
 *   error?: string | null,
 *   recordError?: string | null,
 *   onRetry?: () => void,
 *   isMissing?: boolean,
 *   isDeleted?: boolean,
 * }} props
 */
export default function SpinnerOverlay({
  stage,
  error,
  recordError,
  onRetry,
  isMissing,
  isDeleted,
}) {
  if (isMissing) {
    return (
      <OverlayShell
        title="Article Not Found"
        body="This article could not be found. It may not have been submitted yet."
      />
    );
  }

  if (isDeleted) {
    return (
      <OverlayShell
        title="Article Deleted"
        body="This article was deleted while the canvas was open."
      />
    );
  }

  // `recordError` is `undefined` when there is no pipeline error; an empty
  // string still means "pipeline failed" (just without a message), so this must
  // stay an explicit `!== undefined` check rather than a truthiness test.
  if (recordError !== undefined) {
    return (
      <OverlayShell title="Processing Failed" body={recordError || undefined} onRetry={onRetry} />
    );
  }

  if (error) {
    return <OverlayShell title="Error" body={error} />;
  }

  return (
    <div className="pagetollm-spinner-overlay" role="status" aria-live="polite">
      <div className="pagetollm-spinner-box">
        <div className="pagetollm-spinner" />
        <div className="pagetollm-spinner-stage">{stage || 'Processing...'}</div>
      </div>
    </div>
  );
}
