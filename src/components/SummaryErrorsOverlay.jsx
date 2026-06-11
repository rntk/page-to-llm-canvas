import React, { useState } from 'react';
import { closeModal } from '../closeModal.js';

/**
 * Confirm popup shown when a record is parked in `needs_attention`: some topic
 * summaries kept failing after the automatic retries. The user decides once for
 * all of them — retry every failed topic, or skip them (accept empty summaries
 * and finish). Buttons disable while the decision is in flight.
 *
 * @param {{
 *   summaryErrors?: Array<{topic: string, error_kind?: string, error_message?: string, error_detail?: string}>,
 *   onRetry: () => (void | Promise<void>),
 *   onSkip: () => (void | Promise<void>),
 * }} props
 */
export default function SummaryErrorsOverlay({ summaryErrors, onRetry, onSkip }) {
  const [busy, setBusy] = useState(false);
  const errors = Array.isArray(summaryErrors) ? summaryErrors : [];
  const count = errors.length;

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
    <div className="pagetollm-spinner-overlay" role="alertdialog" aria-live="polite">
      <div className="pagetollm-spinner-box">
        <div className="pagetollm-spinner-error-title">
          {count === 1
            ? '1 topic could not be summarized'
            : `${count} topics could not be summarized`}
        </div>
        <div className="pagetollm-spinner-error-body">
          The model kept failing on these after several automatic retries. Retry them, or skip to
          finish with those topics left empty.
        </div>
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
          <button className="pagetollm-spinner-retry-btn" onClick={run(onRetry)} disabled={busy}>
            Retry all
          </button>
          <button className="pagetollm-spinner-skip-btn" onClick={run(onSkip)} disabled={busy}>
            Skip
          </button>
          <button className="pagetollm-spinner-close-btn" onClick={closeModal} disabled={busy}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
