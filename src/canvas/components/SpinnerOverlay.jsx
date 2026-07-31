import React from 'react';
import { closeModal } from '../closeModal.js';
import { splitError } from '../../utils/errorUtils.js';
import ErrorDetails from '../../components/ErrorDetails.jsx';

/**
 * Shared chrome for every overlay state: a centered box with a title, an
 * optional body line, and an actions row. The default "processing" state is the
 * one exception (it shows a spinner instead of a title) and is rendered inline.
 *
 * @param {object} props
 * @param {string} props.title
 * @param {ReactNode} [props.body]
 * @param {function(): void} [props.onRetry]
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
 * @param {object} props
 * @param {string} [props.stage]
 * @param {?string} [props.error]
 * @param {?string} [props.recordError]
 * @param {function(): void} [props.onRetry]
 * @param {boolean} [props.isMissing]
 * @param {boolean} [props.isDeleted]
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
    let body = undefined;
    if (recordError !== '') {
      const { message, details } = splitError(recordError);
      body = (
        <ErrorDetails
          message={message}
          details={details}
          msgClassName="pagetollm-spinner-error-msg"
          detailsClassName="pagetollm-spinner-error-details"
        />
      );
    }

    return <OverlayShell title="Processing Failed" body={body} onRetry={onRetry} />;
  }

  if (error) {
    return <OverlayShell title="Error" body={error} />;
  }

  return (
    <div className="pagetollm-spinner-overlay" role="status" aria-live="polite">
      <div className="pagetollm-spinner-box">
        <div className="pagetollm-spinner" />
        <div className="pagetollm-spinner-stage">{stage || 'Processing...'}</div>
        <div className="pagetollm-spinner-actions">
          <button className="pagetollm-spinner-close-btn" onClick={closeModal}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
