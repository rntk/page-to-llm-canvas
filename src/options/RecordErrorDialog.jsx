import React, { useState } from 'react';
import ErrorDetails from '../components/ErrorDetails.jsx';
import { splitError } from '../utils/errorUtils.js';

/**
 * Modal shown when the user clicks a record's `error` status on the options
 * page. Mirrors the canvas "Processing Failed" overlay (same class names /
 * ErrorDetails split) but lives on a real page instead of the modal iframe, so
 * it owns its own close handler rather than calling `closeModal`.
 *
 * @param {object} props
 * @param {string} [props.sourceUrl]
 * @param {string|null} [props.errorText]
 * @param {function(): (void|Promise<void>)} props.onRetry
 * @param {function(): void} props.onClose
 */
export default function RecordErrorDialog({ sourceUrl, errorText, onRetry, onClose }) {
  const [busy, setBusy] = useState(false);
  const [retryError, setRetryError] = useState(null);
  const hasMessage = errorText != null && String(errorText) !== '';
  const { message, details } = hasMessage ? splitError(errorText) : { message: '', details: '' };

  const handleRetry = async () => {
    if (busy) return;
    setBusy(true);
    setRetryError(null);
    try {
      // On success the parent reloads records and unmounts this dialog; only a
      // failed send returns here, where we re-enable the buttons for a retry.
      await onRetry();
    } catch (e) {
      console.warn('PageToLLM Options retry failed:', e?.message);
      setRetryError(e?.message || 'Retry failed');
      setBusy(false);
    }
  };

  return (
    <div
      className="pagetollm-spinner-overlay pagetollm-options-error-overlay"
      role="alertdialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div className="pagetollm-spinner-box" onClick={(e) => e.stopPropagation()}>
        <div className="pagetollm-spinner-error-title">Processing Failed</div>
        {sourceUrl ? <div className="pagetollm-options-error-source">{sourceUrl}</div> : null}
        {hasMessage ? (
          <div className="pagetollm-spinner-error-body">
            <ErrorDetails
              message={message}
              details={details}
              msgClassName="pagetollm-spinner-error-msg"
              detailsClassName="pagetollm-spinner-error-details"
            />
          </div>
        ) : null}
        {retryError ? (
          <div className="pagetollm-spinner-error-body" role="alert">
            Retry failed: {retryError}
          </div>
        ) : null}
        <div className="pagetollm-spinner-actions">
          <button
            type="button"
            className="pagetollm-spinner-retry-btn"
            onClick={handleRetry}
            disabled={busy}
          >
            {busy ? 'Retrying...' : 'Retry'}
          </button>
          <button
            type="button"
            className="pagetollm-spinner-close-btn"
            onClick={onClose}
            disabled={busy}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
