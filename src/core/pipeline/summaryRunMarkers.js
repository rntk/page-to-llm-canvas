/**
 * Returns whether a run carries a durable marker that identifies its outcome.
 * Retry and skip decisions are made from these per-run markers.
 *
 * @param {object} run
 * @returns {boolean}
 */
export function hasSummaryRunMarker(run) {
  return run?.error === true || run?.forcedEmpty === true || run?.acceptedFailure === true;
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
  return run?.error === true || run?.forcedEmpty === true;
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
    ...(run?.forcedEmpty === true ? { forcedEmpty: true } : {}),
  };
}

/**
 * Converts Skip outcomes finalized into a DONE checkpoint (`forcedEmpty`) back
 * into the `acceptedFailure` directive, so a run that carries the checkpoint
 * forward (a scoped Resplit) reuses them instead of retrying failures the user
 * already accepted. Finalization stamps them `forcedEmpty` again.
 *
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
