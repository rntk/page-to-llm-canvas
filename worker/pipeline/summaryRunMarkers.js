/**
 * Returns whether a run carries a durable marker that identifies its outcome.
 * Topic-level markers are retained for UI/status compatibility, but retry and
 * skip decisions are made from these per-run markers.
 *
 * @param {object} run
 * @returns {boolean}
 */
export function hasSummaryRunMarker(run) {
  return (
    run?.error === true ||
    run?.status === 'failed' ||
    run?.forcedEmpty === true ||
    run?.acceptedFailure === true
  );
}

/**
 * Returns whether a run should be retried on an ordinary resume.
 * `acceptedFailure` is deliberately excluded: Skip accepts that run for the
 * current resume and finalization converts it to `forcedEmpty` afterward.
 *
 * @param {object} run
 * @returns {boolean}
 */
export function isFailedSummaryRun(run) {
  return run?.error === true || run?.status === 'failed' || run?.forcedEmpty === true;
}

/**
 * Stamps old topic-level markers onto concrete runs once. Older checkpoints
 * did not identify the failed run; empty runs are the best available evidence.
 * If a malformed checkpoint has no empty run, mark every run conservatively.
 *
 * @param {object} summary
 * @returns {object}
 */
export function migrateLegacySummaryRunMarkers(summary) {
  if (!summary || typeof summary !== 'object' || !Array.isArray(summary.runs)) return summary;
  if (summary.runs.some(hasSummaryRunMarker)) return summary;

  const marker = summary.acceptedFailure
    ? 'acceptedFailure'
    : summary.error === true || summary.error_kind || summary.error_message || summary.error_detail
      ? 'error'
      : summary.forcedEmpty === true
        ? 'forcedEmpty'
        : null;
  if (!marker || summary.runs.length === 0) return summary;

  const emptyRuns = summary.runs.filter((run) => run && typeof run === 'object' && run.text === '');
  const targets = new Set(
    emptyRuns.length ? emptyRuns : summary.runs.filter((run) => run && typeof run === 'object'),
  );
  if (targets.size === 0) return summary;

  return {
    ...summary,
    runs: summary.runs.map((run) => (targets.has(run) ? { ...run, [marker]: true } : run)),
  };
}

/**
 * Removes retryable failure fields from a run and marks it accepted by Skip.
 *
 * @param {object} run
 * @returns {object}
 */
export function acceptFailedSummaryRun(run) {
  if (!isFailedSummaryRun(run)) return run;
  const {
    error: _error,
    status: _status,
    forcedEmpty: _forcedEmpty,
    error_kind: _errorKind,
    error_message: _errorMessage,
    error_detail: _errorDetail,
    ...cleanRun
  } = run;
  return { ...cleanRun, acceptedFailure: true };
}

/**
 * Projects a stored run while retaining retryable failure markers. The
 * transient `acceptedFailure` directive stays in `topic_summaries`; it is not
 * part of the UI-facing index.
 *
 * @param {object} run
 * @returns {object}
 */
export function publicSummaryRun(run) {
  return {
    sentences: run?.sentences,
    text: typeof run?.text === 'string' ? run.text : '',
    ...(run?.error === true ? { error: true } : {}),
    ...(run?.status === 'failed' ? { status: 'failed' } : {}),
    ...(run?.forcedEmpty === true ? { forcedEmpty: true } : {}),
  };
}
