import { acceptFailedSummaryRun } from '../../../worker/pipeline/summaryRunMarkers.js';

/**
 * Returns a copy of the topic-summaries map with in-flight error markers
 * replaced by per-run `acceptedFailure: true` markers, so successful sibling
 * runs remain reusable while only the explicitly failed runs are accepted as-is
 * on the next resume.
 *
 * @param {Record<string, object>} topicSummaries
 * @returns {Record<string, object>}
 */
export function clearSummaryErrorFlags(topicSummaries) {
  const src = topicSummaries && typeof topicSummaries === 'object' ? topicSummaries : {};
  const out = {};
  for (const [name, s] of Object.entries(src)) {
    if (s && typeof s === 'object') {
      const {
        error: _error,
        error_kind: _errorKind,
        error_message: _errorMessage,
        error_detail: _errorDetail,
        ...rest
      } = s;
      // Replace the stripped flags with the transient `acceptedFailure` marker:
      // the resumed run must still recognize the leaf as failed (so ancestor
      // summaries skip its source and finalization stamps `forcedEmpty`), while
      // `planSummaryWork` deliberately ignores the marker and reuses the leaf
      // as-is — no re-query, which is the whole point of "skip".
      const runs = (Array.isArray(rest.runs) ? rest.runs : []).map(acceptFailedSummaryRun);
      const acceptedRun = runs.some((run) => run?.acceptedFailure === true);
      out[name] = {
        ...rest,
        runs,
        ...(acceptedRun ? { acceptedFailure: true } : {}),
      };
    } else {
      out[name] = s;
    }
  }
  return out;
}

/**
 * Finds merge-only failures in a parked record. Leaf failures live on
 * `topic_summaries` with `error: true`; a parked error without that marker was
 * raised while resolving an internal tree node. On "skip" we preserve those
 * paths as a transient directive so the resumed run can finalize their empty
 * result without sending the same source-summary request again.
 *
 * @param {object[]} summaryErrors
 * @param {Record<string, object>} topicSummaries
 * @returns {string[]}
 */
export function getAcceptedMergeFailurePaths(summaryErrors, topicSummaries) {
  const summaries = topicSummaries && typeof topicSummaries === 'object' ? topicSummaries : {};
  const paths = new Set();
  for (const error of Array.isArray(summaryErrors) ? summaryErrors : []) {
    const path = error && typeof error.topic === 'string' ? error.topic : '';
    if (path && !summaries[path]?.error) paths.add(path);
  }
  return [...paths];
}

/**
 * @param {string} s
 * @returns {Promise<string>}
 */
export async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  const bytes = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}
