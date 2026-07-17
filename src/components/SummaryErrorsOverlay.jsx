import React, { useEffect, useRef, useState } from 'react';
import { closeModal } from '../canvas/closeModal.js';

/**
 * Confirm popup shown when a record is parked in `needs_attention`: some topic
 * summaries kept failing after the automatic retries. The user decides once for
 * all of them — retry every failed topic, or skip them (accept empty summaries
 * and finish). Buttons disable while the decision is in flight.
 *
 * @param {{
 *   summaryErrors?: Array<{topic: string, error_kind?: string, error_message?: string, error_detail?: string}>,
 *   sourceUrl?: string,
 *   className?: string,
 *   onRetry: () => (void | Promise<void>),
 *   onSkip: () => (void | Promise<void>),
 *   onClose?: () => void,
 * }} props
 */
export default function SummaryErrorsOverlay({
  summaryErrors,
  sourceUrl,
  className = '',
  onRetry,
  onSkip,
  onClose = closeModal,
}) {
  const [busy, setBusy] = useState(false);
  const overlayRef = useRef(null);
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

  useEffect(() => {
    const previouslyFocused = document.activeElement;
    retryButtonRef.current?.focus();

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (!busyRef.current) onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = Array.from(
        overlayRef.current?.querySelectorAll(
          'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ) || [],
      );
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (
        event.shiftKey &&
        (document.activeElement === first || document.activeElement === overlayRef.current)
      ) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) {
        previouslyFocused.focus();
      }
    };
  }, []);

  const run = (fn) => async () => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } catch (_) {
      // The pipeline status drives the UI; a failed send just re-enables the
      // buttons so the user can try again.
      setBusy(false);
    }
  };

  return (
    <div
      ref={overlayRef}
      className={['pagetollm-spinner-overlay', className].filter(Boolean).join(' ')}
      role="alertdialog"
      aria-live="polite"
      aria-modal="true"
      aria-labelledby="pagetollm-summary-errors-title"
      aria-describedby="pagetollm-summary-errors-description"
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div className="pagetollm-spinner-box">
        <div id="pagetollm-summary-errors-title" className="pagetollm-spinner-error-title">
          {count === 1
            ? '1 topic could not be summarized'
            : `${count} topics could not be summarized`}
        </div>
        <div id="pagetollm-summary-errors-description" className="pagetollm-spinner-error-body">
          The model kept failing on these after several automatic retries. Retry them, or skip to
          finish with those topics left empty.
        </div>
        {sourceUrl ? <div className="pagetollm-summary-errors-source">{sourceUrl}</div> : null}
        {count > 0 && (
          <ul className="pagetollm-summary-errors-list">
            {errors.map((e, i) => (
              <li key={`${e.topic}-${i}`} className="pagetollm-summary-errors-item">
                <span className="pagetollm-summary-errors-topic">
                  {e.topic || 'Untitled topic'}
                </span>
                {e.error_message && (
                  <span className="pagetollm-summary-errors-reason">{e.error_message}</span>
                )}
              </li>
            ))}
          </ul>
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
