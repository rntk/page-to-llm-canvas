import React, { useEffect, useRef, useState } from 'react';
import { closeModal } from '../canvas/closeModal.js';
import { isStaleActionError, STALE_ACTION_MESSAGE } from '../shared/runtime/actionResponses.js';

/**
 * Confirm popup shown when a record is parked in `needs_attention`: some topic
 * summaries kept failing after the automatic retries. The user decides once for
 * all of them — retry every failed topic, or skip them (accept empty summaries
 * and finish). Buttons disable while the decision is in flight.
 *
 * @param {object} props
 * @param {Array<{topic: string, error_kind: string, error_message: string, error_detail: string}>} [props.summaryErrors]
 * @param {string} [props.sourceUrl]
 * @param {string} [props.className]
 * @param {function(): (void | Promise<void>)} props.onRetry
 * @param {function(): (void | Promise<void>)} props.onSkip
 * @param {function(): void} [props.onClose]
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
  const [actionError, setActionError] = useState(null);
  const [staleNotice, setStaleNotice] = useState(null);
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
    setActionError(null);
    setStaleNotice(null);
    try {
      const result = await fn();
      // `stale` means the decision already took effect — another window
      // resolved it, or the pipeline moved on — so it is information, not a
      // failure: asking the user to try again would be a lie.
      if (result?.stale === true) setStaleNotice(STALE_ACTION_MESSAGE);
    } catch (e) {
      if (isStaleActionError(e)) {
        setStaleNotice(e.message);
        return;
      }
      // The pipeline status drives the UI; a failed send just re-enables the
      // buttons so the user can try again, plus surfaces the failure so it
      // isn't silently swallowed.
      console.warn('PageToLLM SummaryErrorsOverlay action failed:', e?.message);
      setActionError(e?.message || 'The request failed. Please try again.');
    } finally {
      // Always re-enable: a successful decision must not leave the buttons —
      // and Escape / backdrop dismissal — locked out forever.
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
          The model kept failing on these after several automatic retries. Retry them, or skip these
          failures and continue. Any new failures will still need review.
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
