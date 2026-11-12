import React, { useEffect, useRef, useState } from 'react';
import { clickedOutsideDialog, useModalDialog } from '../shared/useModalDialog.js';
import { isStaleActionError, STALE_ACTION_MESSAGE } from '../shared/runtime/actionResponses.js';
import { createLogger } from '../shared/runtime/log.js';

const log = createLogger('SummaryErrorsOverlay');

/**
 * Confirm popup shown when a record is parked in `needs_attention`: some topic
 * summaries kept failing after the automatic retries. The user decides once for
 * all of them — retry every failed topic, or skip them (accept empty summaries
 * and finish). Buttons disable while the decision is in flight.
 *
 * Rendered only by the Options page: the in-page surfaces (rails, canvas,
 * hierarchy) are read-only and route this decision here.
 *
 * @param {object} props
 * @param {Array<{topic: string, error_kind: string, error_message: string, error_detail: string}>} [props.summaryErrors]
 * @param {string} [props.sourceUrl]
 * @param {string} [props.className]
 * @param {function(): (void | Promise<void>)} props.onRetry
 * @param {function(): (void | Promise<void>)} props.onSkip
 * @param {function(): void} props.onClose
 */
export default function SummaryErrorsOverlay({
  summaryErrors,
  sourceUrl,
  className = '',
  onRetry,
  onSkip,
  onClose,
}) {
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);
  const [staleNotice, setStaleNotice] = useState(null);
  const dialogRef = useRef(null);
  const retryButtonRef = useRef(null);
  const busyRef = useRef(false);
  const onCloseRef = useRef(onClose);
  const errors = Array.isArray(summaryErrors) ? summaryErrors : [];
  const count = errors.length;

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useModalDialog(dialogRef, { initialFocus: retryButtonRef });

  const run = (fn) => async () => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    setStaleNotice(null);
    try {
      const result = await fn();
      // A stale decision was already resolved or superseded; do not prompt a retry.
      if (result?.stale === true) setStaleNotice(STALE_ACTION_MESSAGE);
    } catch (e) {
      if (isStaleActionError(e)) {
        setStaleNotice(e.message);
        return;
      }
      // Surface send failures and let the user retry.
      log.warn('action failed:', e?.message);
      setActionError(e?.message || 'The request failed. Please try again.');
    } finally {
      // Always restore buttons and dismissal after the request settles.
      setBusy(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className={['pagetollm-spinner-box', className].filter(Boolean).join(' ')}
      role="alertdialog"
      aria-live="polite"
      aria-labelledby="pagetollm-summary-errors-title"
      aria-describedby="pagetollm-summary-errors-description"
      onCancel={(event) => {
        event.preventDefault();
        if (!busyRef.current) onCloseRef.current?.();
      }}
      onClick={(event) => {
        if (!busy && clickedOutsideDialog(event)) onClose?.();
      }}
    >
      <div id="pagetollm-summary-errors-title" className="pagetollm-spinner-error-title">
        {count === 1
          ? '1 topic could not be summarized'
          : `${count} topics could not be summarized`}
      </div>
      <div id="pagetollm-summary-errors-description" className="pagetollm-spinner-error-body">
        The model kept failing on these after several automatic retries. Retry them, or skip these
        failures and continue. Any new failures will still need review.
      </div>
      {sourceUrl ? <div className="pagetollm-summary-errors-source">{sourceUrl}</div> : null}
      {count > 0 && (
        <ul className="pagetollm-summary-errors-list">
          {errors.map((e, i) => (
            <li key={`${e.topic}-${i}`} className="pagetollm-summary-errors-item">
              <span className="pagetollm-summary-errors-topic">{e.topic || 'Untitled topic'}</span>
              {e.error_message && (
                <span className="pagetollm-summary-errors-reason">{e.error_message}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {actionError && (
        <div className="pagetollm-spinner-error-body" role="alert">
          {actionError}
        </div>
      )}
      {staleNotice && (
        <div className="pagetollm-spinner-error-body" role="status">
          {staleNotice}
        </div>
      )}
      <div className="pagetollm-spinner-actions">
        <button
          ref={retryButtonRef}
          type="button"
          className="pagetollm-spinner-retry-btn"
          onClick={run(onRetry)}
          disabled={busy}
        >
          Retry all
        </button>
        <button
          type="button"
          className="pagetollm-spinner-skip-btn"
          onClick={run(onSkip)}
          disabled={busy}
        >
          Skip
        </button>
        <button
          type="button"
          className="pagetollm-spinner-close-btn"
          onClick={() => onClose?.()}
          disabled={busy}
        >
          Close
        </button>
      </div>
    </dialog>
  );
}
