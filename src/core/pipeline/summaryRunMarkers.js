// Persisted lifecycle: a provider failure is `error`; Retry schedules that run
// again, while Skip changes it to `acceptedFailure` for the current resume.
// Finalization changes accepted (or still failed) runs to `forcedEmpty`, so a
// later ordinary resume retries them. Successful sibling runs remain reusable.
// The same flags on a summary entry aggregate its runs; older checkpoints may
// also have an entry-level acceptedFailure without a corresponding run marker.

/**
 * Whether a run carries a durable outcome marker; retry and skip decisions use these.
 * @param {object} run
 * @returns {boolean}
 */
export function hasSummaryRunMarker(run) {
  return run?.error === true || run?.forcedEmpty === true || run?.acceptedFailure === true;
}

/**
 * Whether a run is retried on an ordinary resume. `acceptedFailure` is excluded:
 * Skip accepts it for the current resume, then finalization makes it `forcedEmpty`.
 * @param {object} run
 * @returns {boolean}
 */
export function isFailedSummaryRun(run) {
  return run?.error === true || run?.forcedEmpty === true;
}

/**
 * Strip retryable failure fields from a run and mark it accepted by Skip.
 * @param {object} run
 * @returns {object}
 */
export function acceptFailedSummaryRun(run) {
  if (!isFailedSummaryRun(run)) return run;
  const {
    error: _error,
    forcedEmpty: _forcedEmpty,
    error_kind: _errorKind,
    error_message: _errorMessage,
    error_detail: _errorDetail,
    ...cleanRun
  } = run;
  return { ...cleanRun, acceptedFailure: true };
}

/**
 * Project in-flight leaf summaries to the persisted DONE representation.
 * @param {Record<string, object>} summaries
 * @returns {Record<string, object>}
 */
export function finalizeSummaryEntries(summaries) {
  const result = {};
  for (const [name, summary] of Object.entries(summaries)) {
    const runs = (Array.isArray(summary.runs) ? summary.runs : []).map((run) => ({
      sentences: run.sentences,
      text: typeof run.text === 'string' ? run.text : '',
      ...(run?.acceptedFailure === true || isFailedSummaryRun(run) ? { forcedEmpty: true } : {}),
    }));
    result[name] = {
      runs,
      source_sentences: summary.source_sentences,
      ...(summary.error || summary.acceptedFailure || runs.some((run) => run.forcedEmpty === true)
        ? { forcedEmpty: true }
        : {}),
    };
  }
  return result;
}

/**
 * Project a stored run, keeping retryable failure markers. The transient
 * `acceptedFailure` directive stays in `topic_summaries`, out of the UI index.
 * @param {object} run
 * @returns {object}
 */
export function publicSummaryRun(run) {
  return {
    sentences: run?.sentences,
    text: typeof run?.text === 'string' ? run.text : '',
    ...(run?.error === true ? { error: true } : {}),
    ...(run?.forcedEmpty === true ? { forcedEmpty: true } : {}),
  };
}

/**
 * Restore accepted failures from finalized `forcedEmpty` markers when a scoped
 * Resplit carries the checkpoint forward; finalization stamps them again.
 * @param {Record<string, object>} summaries
 * @returns {{summaries: Record<string, object>, hasAcceptedFailure: boolean}}
 */
export function reacceptForcedEmptySummaries(summaries) {
  const result = {};
  let hasAcceptedFailure = false;
  for (const [path, summary] of Object.entries(summaries || {})) {
    const runs = Array.isArray(summary?.runs) ? summary.runs : [];
    if (!runs.some((run) => run?.forcedEmpty === true)) {
      result[path] = summary;
      continue;
    }
    const { forcedEmpty: _forcedEmpty, ...rest } = summary;
    result[path] = {
      ...rest,
      runs: runs.map((run) => (run?.forcedEmpty === true ? acceptFailedSummaryRun(run) : run)),
      acceptedFailure: true,
    };
    hasAcceptedFailure = true;
  }
  return { summaries: result, hasAcceptedFailure };
}
