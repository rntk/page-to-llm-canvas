// Verbose diagnostics payloads are capped independently of the (already
// privacy-safe) counts recorded by recordParserMetric, since they carry raw
// index lists / response text and only ever reach the record's processingLog
// when the verbose-logs setting is on.
const DIAGNOSTICS_LOG_CAP = 50;
const RAW_RESPONSE_LOG_MAX_CHARS = 20000;

/**
 * True when parse diagnostics show any permissive-parser quirk worth
 * surfacing verbosely (as opposed to a clean parse with nothing to explain).
 * @param {object} diagnostics Parser diagnostics.
 */
export function hasDiagnosticQuirks(diagnostics) {
  if (!diagnostics) return false;
  return (
    (diagnostics.invalidRangeTokens || 0) > 0 ||
    (diagnostics.outOfRange || []).length > 0 ||
    (diagnostics.duplicates || []).length > 0 ||
    (diagnostics.missing || []).length > 0 ||
    (diagnostics.reversedRanges || 0) > 0 ||
    (diagnostics.ignoredLineCount || 0) > 0
  );
}

/** Cap a raw array for logging, reporting whether entries were dropped.
 * @param {Array<unknown>} arr Values to cap.
 * @param {number} [cap] Maximum number of values to retain.
 */
export function capForLog(arr, cap = DIAGNOSTICS_LOG_CAP) {
  const values = arr || [];
  return { values: values.slice(0, cap), truncated: values.length > cap };
}

/**
 * Compact a sorted list of sentence indices (e.g. diagnostics.duplicates /
 * .missing) into inclusive range strings, e.g. [3,4,5,6,7,8,9,14] -> ["3-9",
 * "14"], capped at `cap` compacted entries.
 * @param {number[]} indices Sorted sentence indices.
 * @param {number} [cap] Maximum number of compacted entries to retain.
 */
export function compactIndexRanges(indices, cap = DIAGNOSTICS_LOG_CAP) {
  const compacted = [];
  let i = 0;
  const list = indices || [];
  while (i < list.length) {
    const start = list[i];
    let end = start;
    let j = i + 1;
    while (j < list.length && list[j] === end + 1) {
      end = list[j];
      j++;
    }
    compacted.push(start === end ? `${start}` : `${start}-${end}`);
    i = j;
  }
  return { values: compacted.slice(0, cap), truncated: compacted.length > cap };
}

/** Shared payload for the `topic_ranges_parse_diagnostics` verbose log.
 * @param {object} diagnostics Parser diagnostics.
 */
function buildParseDiagnosticsLogDetails(diagnostics) {
  const outOfRange = capForLog(diagnostics.outOfRange);
  const duplicates = compactIndexRanges(diagnostics.duplicates);
  const missing = compactIndexRanges(diagnostics.missing);
  const repairs = capForLog(diagnostics.repairs);
  return {
    sentenceCount: diagnostics.sentenceCount,
    inputLineCount: diagnostics.inputLineCount,
    parsedLineCount: diagnostics.parsedLineCount,
    ignoredLineCount: diagnostics.ignoredLineCount,
    parsedRangeCount: diagnostics.parsedRangeCount,
    invalidRangeTokens: diagnostics.invalidRangeTokens,
    reversedRanges: diagnostics.reversedRanges,
    outOfRange: outOfRange.values,
    outOfRangeTruncated: outOfRange.truncated,
    duplicates: duplicates.values,
    duplicatesTruncated: duplicates.truncated,
    missing: missing.values,
    missingTruncated: missing.truncated,
    repairs: repairs.values,
    repairsTruncated: Boolean(diagnostics.repairsTruncated) || repairs.truncated,
    ignoredLineSamples: diagnostics.ignoredLineSamples || [],
  };
}

/** Shared payload for the `topic_ranges_raw_response` verbose log.
 * @param {unknown} rawResponse Raw model response.
 */
function buildRawResponseLogDetails(rawResponse) {
  const text = typeof rawResponse === 'string' ? rawResponse : String(rawResponse ?? '');
  return {
    responseLength: text.length,
    truncated: text.length > RAW_RESPONSE_LOG_MAX_CHARS,
    response: text.slice(0, RAW_RESPONSE_LOG_MAX_CHARS),
  };
}

/**
 * Emits the diagnostics + raw-response verbose log pair. The two entries always
 * travel together and share their context fields, so they are built once here
 * rather than restated at each call site (primary/resplit × quirky-success and
 * parse-failure).
 * @param {PipelineRuntime} runtime Pipeline runtime.
 * @param {object} context Fields identifying which parse this describes.
 * @param {object} payload
 * @param {object} payload.diagnostics Parser diagnostics to summarize.
 * @param {unknown} payload.response Raw model response.
 */
export async function logParseDiagnostics(runtime, context, { diagnostics, response }) {
  await runtime.log(
    'topic_ranges_parse_diagnostics',
    { ...context, ...buildParseDiagnosticsLogDetails(diagnostics) },
    { verbose: true },
  );
  await runtime.log(
    'topic_ranges_raw_response',
    { ...context, ...buildRawResponseLogDetails(response) },
    { verbose: true },
  );
}
