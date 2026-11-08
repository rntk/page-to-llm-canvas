import { PIPELINE_STATUS } from '../shared/runtime/contracts.js';
import { splitError } from '../utils/errorUtils.js';
import ErrorDetails from '../components/ErrorDetails.jsx';

function ErrorState({ title, message, details, onClose }) {
  return (
    <div className="th-page__state th-page__state--error" role="alert">
      <div className="th-page__error-title">{title}</div>
      {message && (
        <ErrorDetails
          message={message}
          details={details}
          msgClassName="th-page__error-message"
          detailsClassName="th-page__error-details"
        />
      )}
      <div className="th-page__error-message">
        Open the Options page to retry this analysis from the Records section.
      </div>
      <div className="th-page__error-actions">
        <button type="button" className="th-page__close-btn" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

/** Show the record's load and processing state before rendering its tree. */
export default function RecordStateGate({ record, error, onClose, children }) {
  if (error && !record) {
    return <div className="th-page__state">Error: {String(error)}</div>;
  } else if (!record) {
    return <div className="th-page__state">Loading…</div>;
  } else if (
    record.status === PIPELINE_STATUS.ERROR ||
    record.status === PIPELINE_STATUS.CANCELLED
  ) {
    const { message, details } = splitError(
      record.error || 'Unknown error occurred during processing.',
    );
    return (
      <ErrorState title="Processing Failed" message={message} details={details} onClose={onClose} />
    );
  } else if (record.status === PIPELINE_STATUS.NEEDS_ATTENTION) {
    const count = Array.isArray(record.summaryErrors) ? record.summaryErrors.length : 0;
    return (
      <ErrorState
        title={count === 1 ? '1 topic needs attention' : `${count} topics need attention`}
        onClose={onClose}
      />
    );
  } else if (record.status !== PIPELINE_STATUS.DONE) {
    return <div className="th-page__state">Still processing this page…</div>;
  }
  return children;
}
