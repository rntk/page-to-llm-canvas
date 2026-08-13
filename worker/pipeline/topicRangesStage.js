import { stripTagsKeepOffsets } from './html.js';
import { splitSentences } from './sentenceSplitter.js';
import { buildTaggedText, buildTopicRangesPrompt } from './prompts.js';
import { parseTopicRangesDetailed, groupsFromSegments, TopicParseError } from './topicParser.js';
import { recordParserMetric } from '../metrics/parser.js';
import {
  RESPLIT_OUTCOMES,
  createResplitRunStats,
  noteResplitOutcome,
  recordResplitRun,
} from '../metrics/resplit.js';
import { parallelMap } from '../llm/llm.js';
import { LLM_TASK_TYPES } from '../metrics/llm.js';
import { computeBackoffDelay, queryTopicRangesWithRetry } from './topicRangeRetry.js';
import {
  MAX_TAGGED_CHARS,
  TOPIC_RANGE_INPUT_MAX_SENTENCES,
  TOPIC_RANGE_PROVIDER_MAX_ATTEMPTS,
  TOPIC_RANGE_RESPLIT_PROVIDER_MAX_ATTEMPTS,
  TOPIC_RANGE_STAGE_MAX_RETRIES,
} from './pipelineConfig.js';
import { PIPELINE_STAGE, PIPELINE_STATUS } from '../../src/shared/runtime/contracts.js';
import { isCancellationError, rethrowIfCancelled, throwIfCancelled } from './cancellation.js';
import { isPermanentProviderError } from './providerFailure.js';

const ABORT_MESSAGE = 'pipeline aborted during topic ranging';

const TOPIC_RANGE_CONCURRENCY = 4;
const TOPIC_RANGE_TEMPERATURE = 0.2;
const TOPIC_RANGE_RETRY_BASE_DELAY_MS = 2000;
// Same ceiling callLLMWithRetry applies to a provider's Retry-After, so a
// hostile or misconfigured header cannot park the stage indefinitely.
const MAX_PROVIDER_COOLDOWN_MS = 60_000;
const TOPIC_RANGE_MAX_SENTENCES = 40;
const TOPIC_RANGE_RESPLIT_MAX_DEPTH = 2;

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
function hasDiagnosticQuirks(diagnostics) {
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
function capForLog(arr, cap = DIAGNOSTICS_LOG_CAP) {
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
function compactIndexRanges(indices, cap = DIAGNOSTICS_LOG_CAP) {
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
async function logParseDiagnostics(runtime, context, { diagnostics, response }) {
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

export function chunkTaggedText(tagged, maxChars) {
  const lines = tagged.split('\n').map((line) => fitTextToChars(line, maxChars));
  const chunks = [];
  let cur = [];
  let curLen = 0;
  for (const line of lines) {
    const lineLen = line.length + 1;
    if (curLen + lineLen > maxChars && cur.length > 0) {
      chunks.push(cur.join('\n'));
      cur = [];
      curLen = 0;
    }
    cur.push(line);
    curLen += lineLen;
  }
  if (cur.length) chunks.push(cur.join('\n'));
  return chunks;
}

function fitTextToChars(text, maxChars) {
  const value = String(text || '');
  if (value.length <= maxChars) return value;
  if (maxChars <= 1) return value.slice(0, maxChars);
  const separator = '…';
  const retained = maxChars - separator.length;
  const headLength = Math.ceil(retained / 2);
  return `${value.slice(0, headLength)}${separator}${value.slice(value.length - (retained - headLength))}`;
}

function taggedSentenceLine(localIndex, sentence, maxChars) {
  const prefix = `{${localIndex}} `;
  if (prefix.length >= maxChars) return prefix.slice(0, maxChars);
  return `${prefix}${fitTextToChars(sentence, maxChars - prefix.length)}`;
}

/**
 * Build independently parseable topic-range inputs. Marker IDs intentionally
 * restart at zero in each chunk so the parser can validate and repair coverage
 * against that chunk alone. `start` maps the local IDs back to the article.
 * @param {string[]|object[]} sentences Source sentences.
 * @param {number} [maxChars] Maximum chunk size.
 * @param {number} [maxSentences] Maximum sentences per chunk.
 */
export function chunkTopicRangeSentences(
  sentences,
  maxChars = MAX_TAGGED_CHARS,
  maxSentences = TOPIC_RANGE_INPUT_MAX_SENTENCES,
) {
  if (!Array.isArray(sentences) || sentences.length === 0) return [];
  if (!Number.isFinite(maxChars) || maxChars <= 0) throw new Error('maxChars must be positive');
  if (!Number.isInteger(maxSentences) || maxSentences <= 0) {
    throw new Error('maxSentences must be a positive integer');
  }

  const chunks = [];
  let start = 0;
  while (start < sentences.length) {
    const lines = [];
    let length = 0;
    while (start + lines.length < sentences.length && lines.length < maxSentences) {
      const value = sentences[start + lines.length];
      const sentence = typeof value === 'string' ? value : value?.text;
      // One pathological sentence (minified data, a data URL, etc.) must not
      // defeat the request budget. Topic ranging only needs enough of that
      // indivisible sentence to label it, so preserve both its head and tail.
      const line = taggedSentenceLine(lines.length, sentence ?? '', maxChars);
      const addedLength = line.length + (lines.length > 0 ? 1 : 0);
      if (lines.length > 0 && length + addedLength > maxChars) break;
      lines.push(line);
      length += addedLength;
    }

    const sentenceCount = lines.length;
    chunks.push({ start, sentenceCount, tagged: lines.join('\n') });
    start += sentenceCount;
  }
  return chunks;
}

/**
 * Aggregate failure for the primary topic-ranges stage: one or more chunks did
 * not produce parsed segments this attempt. It carries the per-chunk detail so
 * the retry loop can re-request only those chunks, and a single `retryable`
 * verdict so a permanently-failing chunk (a 401, a malformed request) aborts
 * the stage immediately instead of burning three more backoff rounds — no
 * amount of retrying can complete coverage without it.
 */
export class TopicRangeChunkError extends Error {
  constructor(message, { chunkIndexes = [], errors = [], retryable = true } = {}) {
    super(message);
    this.name = 'TopicRangeChunkError';
    this.chunkIndexes = chunkIndexes;
    this.errors = errors;
    this.retryable = retryable;
  }
}

/** The provider cooldown this stage will actually honor, already capped.
 * @param {unknown} error Error carrying a provider Retry-After, if any.
 */
function providerCooldownMs(error) {
  const requested = error?.retryAfterMs;
  return Number.isFinite(requested) && requested > 0
    ? Math.min(requested, MAX_PROVIDER_COOLDOWN_MS)
    : 0;
}

/**
 * Builds the aggregate error for the chunks still missing segments. Retryable
 * only when EVERY failure is retryable.
 * @param {object[]} failedStates Chunk states without parsed segments.
 * @param {number} chunkCount Total chunk count for the article.
 */
function buildChunkFailureError(failedStates, chunkCount) {
  const retryable = failedStates.every((state) =>
    state.parseError
      ? state.parseError instanceof TopicParseError
      : !isPermanentProviderError(state.dispatchError),
  );
  const chunkIndexes = failedStates.map((state) => state.chunkIndex);
  const errors = failedStates.map((state) => state.parseError || state.dispatchError);
  const first = errors.find(Boolean);
  const firstMessage = (first && first.message) || 'unknown error';
  const label = compactIndexRanges(chunkIndexes).values.join(', ');
  const aggregate = new TopicRangeChunkError(
    `${failedStates.length} of ${chunkCount} topic-range chunks failed (chunk ${label}): ${firstMessage}`,
    { chunkIndexes, errors, retryable },
  );
  // A provider error used to reach runPipeline as itself; keep its HTTP
  // classification visible on the aggregate. Taken from the first error that
  // HAS one rather than the first error outright, so a leading parse failure
  // does not hide a sibling chunk's 429 — the same reason the cooldown below
  // scans every error.
  // Deliberately NOT chained as `cause`: isCancellationError walks the cause
  // chain and trusts abort SHAPE whenever the signal is aborted, so an
  // abort-shaped transport timeout hidden there could make a later cancellation
  // launder this genuine failure into a silent no-op instead of an ERROR write.
  // The originals stay reachable on `.errors`, which nothing walks.
  const status = errors.find((error) => Number.isFinite(error?.status))?.status;
  if (status !== undefined) aggregate.status = status;
  // The LONGEST cooldown any failed chunk was given, not the first one's: the
  // next attempt re-dispatches all of them together, so respecting anything
  // shorter would still hit the provider inside a cooldown it asked for.
  const cooldowns = errors
    .map((error) => error?.retryAfterMs)
    .filter((ms) => Number.isFinite(ms) && ms > 0);
  if (cooldowns.length > 0) aggregate.retryAfterMs = Math.max(...cooldowns);
  return aggregate;
}

/**
 * Validates a persisted topic-ranges checkpoint against the chunks just
 * derived from the current sentences, returning the per-chunk segments that
 * may be reused (null where the chunk still needs an LLM request), or null
 * when nothing is reusable.
 *
 * Deliberately all-or-nothing on any structural surprise: the checkpoint is
 * only a cost optimization, so a half-trusted one is never worth the risk of
 * feeding bogus ranges into groupsFromSegments. It also has to survive an
 * imported record, where every field is user-supplied JSON — hence the bounds
 * check of each segment against its own chunk rather than trusting `start`.
 *
 * @param {object} record Record snapshot read at pipeline start.
 * @param {object[]} chunks Chunks derived from the current sentences.
 * @returns {{segments: (object[]|null)[], reusedChunkCount: number}|null}
 */
export function readTopicRangeChunkCheckpoint(record, chunks) {
  const checkpoint = record?.topic_range_chunks;
  if (!checkpoint || typeof checkpoint !== 'object') return null;
  if (!Array.isArray(chunks) || chunks.length === 0) return null;
  if (!Array.isArray(checkpoint.chunks) || checkpoint.chunks.length !== chunks.length) return null;
  // Without a revision to pin it to, the checkpoint cannot be proven to
  // describe these sentences; recomputing is the only safe answer.
  const revision = record?.contentRevision;
  if (typeof revision !== 'string' || !revision) return null;
  if (checkpoint.contentRevision !== revision) return null;
  const sentenceCount = chunks.reduce((sum, chunk) => sum + chunk.sentenceCount, 0);
  if (checkpoint.sentenceCount !== sentenceCount) return null;

  const segments = new Array(chunks.length).fill(null);
  let reusedChunkCount = 0;
  for (let index = 0; index < chunks.length; index++) {
    const entry = checkpoint.chunks[index];
    if (entry == null) continue;
    if (typeof entry !== 'object') return null;
    const chunk = chunks[index];
    if (entry.start !== chunk.start || entry.sentenceCount !== chunk.sentenceCount) return null;
    if (!Array.isArray(entry.segments)) return null;
    // A chunk this stage completed always carries at least one segment —
    // parseTopicRangesDetailed throws rather than return zero groups. An empty
    // list therefore never came from our own writer, and restoring it would
    // mark the chunk DONE with nothing in it: with every chunk like that,
    // nothing is dispatched, groupsFromSegments throws 'No valid topic ranges'
    // on the empty set, and the checkpoint is never cleared — so every later
    // Retry reads it back and fails identically. Reject it instead.
    if (entry.segments.length === 0) return null;
    const lastSentence = chunk.start + chunk.sentenceCount - 1;
    const restored = [];
    for (const segment of entry.segments) {
      if (!segment || typeof segment !== 'object') return null;
      const { label, start, end } = segment;
      if (!Array.isArray(label) || label.length === 0) return null;
      if (!label.every((part) => typeof part === 'string' && part.trim() !== '')) return null;
      if (!Number.isInteger(start) || !Number.isInteger(end) || start > end) return null;
      if (start < chunk.start || end > lastSentence) return null;
      restored.push({ label: [...label], start, end });
    }
    segments[index] = restored;
    reusedChunkCount++;
  }
  if (reusedChunkCount === 0) return null;
  return { segments, reusedChunkCount };
}

/** Serializes the completed chunks so a later run can skip re-requesting them.
 * @param {string} contentRevision Revision the checkpoint is pinned to.
 * @param {object[]} chunkStates Per-chunk stage state.
 * @param {number} sentenceCount Sentence count the chunks were derived from.
 */
function buildTopicRangeChunkCheckpoint(contentRevision, chunkStates, sentenceCount) {
  return {
    contentRevision,
    sentenceCount,
    chunks: chunkStates.map((state) =>
      state.segments === null
        ? null
        : {
            start: state.chunk.start,
            sentenceCount: state.chunk.sentenceCount,
            segments: state.segments,
          },
    ),
  };
}

/**
 * Persists the completed chunks of the topic-ranges stage.
 *
 * This is called both after a parse round and on the way out of a failed
 * stage.  The write is best-effort and deliberately silent: losing a cost
 * optimization must never replace the real failure the user needs to see.
 * @param {PipelineRuntime} runtime Pipeline runtime.
 * @param {object} record Record snapshot read at pipeline start.
 * @param {object[]} chunkStates Per-chunk stage state.
 * @param {number} sentenceCount Sentence count the chunks were derived from.
 * @param {unknown} error Error that ended the stage.
 */
async function saveTopicRangeChunkCheckpoint(runtime, record, chunkStates, sentenceCount, error) {
  // A cancelled run's partial work belongs to a superseded attempt, and a
  // checkpoint with nothing done (or nothing left to do) saves no requests.
  if (isCancellationError(error, runtime)) return;
  // Same contract readTopicRangeChunkCheckpoint enforces: without a revision to
  // pin it to, the checkpoint would be rejected on read, so writing it is a
  // content-doc write that can never pay for itself.
  const contentRevision = record?.contentRevision;
  if (typeof contentRevision !== 'string' || !contentRevision) return;
  const done = chunkStates.filter((state) => state.segments !== null).length;
  if (done === 0) return;
  try {
    await runtime.update({
      topic_range_chunks: buildTopicRangeChunkCheckpoint(
        contentRevision,
        chunkStates,
        sentenceCount,
      ),
    });
    // allowAborted: the write already landed, so an abort racing this log must
    // not send us down the catch below and report a save that succeeded as
    // failed.
    await runtime.log(
      'topic_ranges_checkpoint_saved',
      { completedChunkCount: done, chunkCount: chunkStates.length },
      { allowAborted: true },
    );
  } catch (writeError) {
    // A lost expectedPipelineRunId CAS means this run no longer owns the
    // record. Unlike an ordinary storage failure, it must stop the retry loop
    // even when the runtime's signal was never aborted.
    rethrowIfCancelled(writeError, runtime, ABORT_MESSAGE);
    await runtime
      .log(
        'topic_ranges_checkpoint_save_failed',
        { error: (writeError && writeError.message) || String(writeError) },
        { allowAborted: true },
      )
      .catch(() => {
        /* The stage error below is the one that matters. */
      });
  }
}

/**
 * Requests every chunk that still needs segments, recording the outcome on each
 * chunk state rather than throwing. A provider failure is confined to its own
 * chunk, so parallelMap's fail-fast no longer discards the responses its
 * siblings already paid for; cancellation still stops the whole burst, since
 * nothing a superseded run produced is wanted.
 *
 * A PERMANENT failure (401, unknown model) is the exception: it condemns every
 * sibling too, so it stops the burst from claiming further chunks. The chunks
 * that were never claimed inherit that error, which keeps them pending, keeps
 * the aggregate non-retryable, and keeps the parser away from their absent
 * responses.
 * @param {object} params
 * @param {PipelineRuntime} params.runtime Pipeline runtime.
 * @param {function(object): Promise<string>} params.callLLMWithRetry Provider call.
 * @param {object[]} params.pending Chunk states still missing segments.
 * @param {number} params.attempt 1-based stage attempt number.
 */
async function dispatchPendingChunks({ runtime, callLLMWithRetry, pending, attempt }) {
  let permanentError = null;
  const dispatched = new Set();
  await parallelMap(
    pending,
    TOPIC_RANGE_CONCURRENCY,
    async (state) => {
      dispatched.add(state);
      state.response = null;
      state.dispatchError = null;
      state.parseError = null;
      const prompt = buildTopicRangesPrompt(state.chunk.tagged, {
        preferContentLanguage: runtime.preferContentLanguage,
      });
      await runtime.log(
        'topic_ranges_llm_request',
        { chunkIndex: state.chunkIndex, promptLength: prompt.length, attempt },
        { verbose: true },
      );
      try {
        // Each worker owns exactly one `state` — parallelMap never hands the same
        // item to two workers — so writing it across an await is not the
        // interleaving the rule is guarding against.
        // eslint-disable-next-line require-atomic-updates
        state.response = await callLLMWithRetry(
          {
            prompt,
            temperature: TOPIC_RANGE_TEMPERATURE,
            signal: runtime.signal,
            taskType: LLM_TASK_TYPES.TOPIC_RANGES,
          },
          TOPIC_RANGE_PROVIDER_MAX_ATTEMPTS,
        );
      } catch (error) {
        rethrowIfCancelled(error, runtime, ABORT_MESSAGE);
        // Sole owner of `state`, as above.
        // eslint-disable-next-line require-atomic-updates
        state.dispatchError = error;
        if (!permanentError && isPermanentProviderError(error)) permanentError = error;
        await runtime.log('topic_ranges_llm_error', {
          chunkIndex: state.chunkIndex,
          attempt,
          error: (error && error.message) || String(error),
        });
        return;
      }
      await runtime.log(
        'topic_ranges_llm_response',
        { chunkIndex: state.chunkIndex, responseLength: state.response.length, attempt },
        { verbose: true },
      );
    },
    { warmupFirst: true, stopBurst: () => permanentError !== null },
  );
  if (!permanentError) return;
  const skipped = pending.filter((state) => !dispatched.has(state));
  if (skipped.length === 0) return;
  for (const state of skipped) {
    state.response = null;
    state.parseError = null;
    // The chunk was never requested; it carries the failure that condemned it
    // so the aggregate stays non-retryable instead of looking like an
    // unexplained empty response.
    state.dispatchError = permanentError;
  }
  const skippedIndexes = capForLog(skipped.map((state) => state.chunkIndex));
  await runtime.log('topic_ranges_llm_skipped', {
    attempt,
    skippedChunkCount: skipped.length,
    skippedChunkIndexes: skippedIndexes.values,
    skippedChunkIndexesTruncated: skippedIndexes.truncated,
    error: (permanentError && permanentError.message) || String(permanentError),
  });
}

/**
 * Parses the responses this attempt dispatched, promoting every chunk that
 * parses to DONE — `segments` set, in article-absolute sentence indexes — and
 * leaving the rest pending for the next attempt.
 * @param {object} params
 * @param {PipelineRuntime} params.runtime Pipeline runtime.
 * @param {object[]} params.dispatched Chunk states dispatched this attempt.
 * @param {number} params.attempt 1-based stage attempt number.
 * @param {Set<number>} params.failedChunkIndexes Chunks that failed to parse earlier.
 */
async function parseDispatchedChunks({ runtime, dispatched, attempt, failedChunkIndexes }) {
  const successfulMetricSamples = [];
  for (const state of dispatched) {
    if (state.dispatchError) continue;
    const { chunk, chunkIndex, response } = state;
    const logContext = { scope: 'primary', attempt, chunkIndex, sentenceStart: chunk.start };
    try {
      const parsed = parseTopicRangesDetailed(response, chunk.sentenceCount);
      if (hasDiagnosticQuirks(parsed.diagnostics)) {
        await logParseDiagnostics(runtime, logContext, {
          diagnostics: parsed.diagnostics,
          response,
        });
      }
      state.segments = parsed.groups.flatMap((group) =>
        group.ranges.map((range) => ({
          label: group.label,
          start: range.start + chunk.start,
          end: range.end + chunk.start,
        })),
      );
      successfulMetricSamples.push({
        ok: true,
        scope: 'primary',
        attempt,
        recoveredAfterRetry: failedChunkIndexes.has(chunkIndex),
        diagnostics: parsed.diagnostics,
      });
    } catch (error) {
      rethrowIfCancelled(error, runtime, ABORT_MESSAGE);
      state.parseError = error;
      const diagnostics = error?.diagnostics || {};
      // One failure sample per failed CHUNK, not per attempt as before: now
      // that a sibling's success is kept, an attempt no longer maps to a single
      // parse outcome. This shifts the parser-metric denominator (a 3-chunk
      // attempt with 2 bad chunks records 2 failures, not 1) — deliberately,
      // since the per-chunk count is what the parser's own error rate is.
      await recordParserMetric({
        ok: false,
        scope: 'primary',
        attempt,
        diagnostics,
        error: error?.message,
      });
      if (error instanceof TopicParseError) {
        failedChunkIndexes.add(chunkIndex);
        await logParseDiagnostics(runtime, logContext, { diagnostics, response });
      }
    }
  }
  // Successes are permanent now, so their samples are recorded as soon as they
  // happen rather than being held until every chunk parses (and discarded when
  // one does not).
  for (const sample of successfulMetricSamples) {
    throwIfCancelled(runtime, ABORT_MESSAGE);
    await recordParserMetric(sample);
  }
}

export function rangesToSentenceList(ranges) {
  // Ranges are 0-based inclusive; output a 1-based ordered unique list.
  const set = new Set();
  for (const range of ranges) {
    for (let i = range.start; i <= range.end; i++) set.add(i);
  }
  return Array.from(set)
    .sort((a, b) => a - b)
    .map((i) => i + 1);
}

export function mapTextOffsetToHtml(mapping, textOffset) {
  if (textOffset < 0) textOffset = 0;
  if (textOffset >= mapping.length) textOffset = mapping.length - 1;
  return mapping[textOffset];
}

export function groupsToTopics(groups, sentenceObjs, mapping) {
  return groups.map((group) => {
    const name = group.label.join('>');
    const oneBased = rangesToSentenceList(group.ranges);
    const sentence_spans = oneBased.map((oneIdx) => {
      const sentence = sentenceObjs[oneIdx - 1];
      return {
        sentence: oneIdx,
        start: mapTextOffsetToHtml(mapping, sentence.start),
        end: mapTextOffsetToHtml(mapping, sentence.end),
      };
    });
    const ranges = group.ranges.map((range) => {
      const startIndex = range.start;
      const endIndex = range.end;
      return {
        sentence_start: startIndex + 1,
        sentence_end: endIndex + 1,
        start: mapTextOffsetToHtml(mapping, sentenceObjs[startIndex].start),
        end: mapTextOffsetToHtml(mapping, sentenceObjs[endIndex].end),
      };
    });
    return { name, sentences: oneBased, sentence_spans, ranges };
  });
}

/**
 * Re-query the LLM to subdivide one oversized sentence range. This is
 * best-effort: a failed re-split returns null so its caller can retain the
 * original range; an ineffective large re-split falls back to bounded windows.
 * @param {PipelineRuntime} runtime Pipeline runtime.
 * @param {object} segment Oversized topic segment.
 * @param {string[]} sentenceTexts Article sentence text.
 * @param {number} depth Current resplit depth.
 * @param {Function} callLLMWithRetry LLM request function.
 * @param {object} [options] Resplit options.
 * @param {boolean} [options.acceptSingle]
 * @param {object} [options.stats]
 */
async function resplitSegment(
  runtime,
  segment,
  sentenceTexts,
  depth,
  callLLMWithRetry,
  { acceptSingle = false, stats = null } = {},
) {
  const span = segment.end - segment.start + 1;
  const sliceTexts = sentenceTexts.slice(segment.start, segment.end + 1);
  const tagged = buildTaggedText(sliceTexts);
  const maxChars = runtime.maxTextChunkChars;
  const chunks = tagged.length > maxChars ? chunkTaggedText(tagged, maxChars) : [tagged];

  if (stats) {
    stats.resplitCallCount++;
    // One request per chunk, not per invocation: an oversized range whose
    // tagged text exceeds MAX_TAGGED_CHARS fans out below, and counting it
    // once would understate cost exactly for the longest ranges.
    stats.llmRequestCount += chunks.length;
  }

  await runtime.log(
    'topic_ranges_resplit_request',
    {
      start: segment.start,
      end: segment.end,
      span,
      depth,
      chunkCount: chunks.length,
    },
    { verbose: true },
  );

  let subGroups;
  try {
    subGroups = await queryTopicRangesWithRetry({
      maxRetries: 0,
      callLLM: async () => {
        const responses = await parallelMap(
          chunks,
          TOPIC_RANGE_CONCURRENCY,
          async (chunk) => {
            try {
              return {
                content: await callLLMWithRetry(
                  {
                    prompt: buildTopicRangesPrompt(chunk, {
                      preferContentLanguage: runtime.preferContentLanguage,
                    }),
                    temperature: TOPIC_RANGE_TEMPERATURE,
                    signal: runtime.signal,
                    taskType: LLM_TASK_TYPES.TOPIC_RANGES,
                  },
                  TOPIC_RANGE_RESPLIT_PROVIDER_MAX_ATTEMPTS,
                ),
              };
            } catch (error) {
              rethrowIfCancelled(error, runtime, ABORT_MESSAGE);
              // Keep every paid-for sibling request in flight before surfacing
              // the failure; parallelMap's default fail-fast would abandon
              // queued chunks as soon as one provider call rejects.
              return { error };
            }
          },
          { warmupFirst: true },
        );
        const failed = responses.find((response) => response.error);
        if (failed) throw failed.error;
        return responses.map((response) => response.content).join('\n');
      },
      parse: async (raw) => {
        const logContext = { scope: 'resplit', depth, start: segment.start, end: segment.end };
        try {
          // The request may have fulfilled just as cancellation landed. Stop
          // before attributing that superseded response to parser metrics.
          throwIfCancelled(runtime, ABORT_MESSAGE);
          const parsed = parseTopicRangesDetailed(raw, sliceTexts.length);
          if (hasDiagnosticQuirks(parsed.diagnostics)) {
            await logParseDiagnostics(runtime, logContext, {
              diagnostics: parsed.diagnostics,
              response: raw,
            });
          }
          throwIfCancelled(runtime, ABORT_MESSAGE);
          await recordParserMetric({ ok: true, scope: 'resplit', diagnostics: parsed.diagnostics });
          return parsed.groups;
        } catch (error) {
          // An AbortError from the boundary check or runtime logging is not a
          // malformed model response and must not become a parser sample.
          rethrowIfCancelled(error, runtime, ABORT_MESSAGE);
          const diagnostics = { ...error?.diagnostics, sentenceCount: sliceTexts.length };
          await recordParserMetric({
            ok: false,
            scope: 'resplit',
            diagnostics,
            error: error?.message,
          });
          if (error instanceof TopicParseError) {
            await logParseDiagnostics(runtime, logContext, { diagnostics, response: raw });
          }
          throw error;
        }
      },
    });
  } catch (error) {
    // A cancelled run is not a resplit failure: recording it would both log a
    // phantom error on the record and bias the ERROR counts that the keep/remove
    // decision for the resplit feature rests on.
    rethrowIfCancelled(error, runtime, ABORT_MESSAGE);
    await runtime.log('topic_ranges_resplit_error', {
      start: segment.start,
      end: segment.end,
      depth,
      error: (error && error.message) || String(error),
    });
    noteResplitOutcome(stats, RESPLIT_OUTCOMES.ERROR);
    return null;
  }

  const offset = segment.start;
  let subSegments = [];
  for (const group of subGroups) {
    for (const range of group.ranges) {
      subSegments.push({
        label: group.label,
        start: range.start + offset,
        end: range.end + offset,
      });
    }
  }
  subSegments.sort((a, b) => a.start - b.start);

  if (subSegments.length <= 1) {
    if (acceptSingle && subSegments.length === 1) {
      noteResplitOutcome(stats, RESPLIT_OUTCOMES.ACCEPTED_SINGLE);
      return subSegments;
    }

    await runtime.log(
      'topic_ranges_resplit_no_progress',
      {
        start: segment.start,
        end: segment.end,
        span,
        depth,
      },
      { verbose: true },
    );

    // A single label over a large slice is often a marker-grounding failure.
    // Re-query deterministic small windows: even a single-topic answer is
    // useful there because its label is grounded in at most 40 sentences.
    if (span > TOPIC_RANGE_MAX_SENTENCES) {
      const windows = [];
      for (let start = segment.start; start <= segment.end; start += TOPIC_RANGE_MAX_SENTENCES) {
        windows.push({
          label: segment.label,
          start,
          end: Math.min(segment.end, start + TOPIC_RANGE_MAX_SENTENCES - 1),
        });
      }
      await runtime.log(
        'topic_ranges_resplit_window_fallback',
        { start: segment.start, end: segment.end, span, depth, windowCount: windows.length },
        { verbose: true },
      );
      noteResplitOutcome(stats, RESPLIT_OUTCOMES.WINDOW_FALLBACK);
      const windowResults = await parallelMap(
        windows,
        TOPIC_RANGE_CONCURRENCY,
        async (window) =>
          (await resplitSegment(runtime, window, sentenceTexts, depth + 1, callLLMWithRetry, {
            acceptSingle: true,
            stats,
          })) || [window],
      );
      return windowResults.flat();
    }
    noteResplitOutcome(stats, RESPLIT_OUTCOMES.NO_PROGRESS);
    return null;
  }

  await runtime.log(
    'topic_ranges_resplit_response',
    {
      start: segment.start,
      end: segment.end,
      span,
      depth,
      subSegmentCount: subSegments.length,
    },
    { verbose: true },
  );
  noteResplitOutcome(stats, RESPLIT_OUTCOMES.SUBDIVIDED);

  if (depth + 1 < TOPIC_RANGE_RESPLIT_MAX_DEPTH) {
    const expanded = await parallelMap(subSegments, TOPIC_RANGE_CONCURRENCY, async (subSegment) => {
      if (subSegment.end - subSegment.start + 1 > TOPIC_RANGE_MAX_SENTENCES) {
        const deeper = await resplitSegment(
          runtime,
          subSegment,
          sentenceTexts,
          depth + 1,
          callLLMWithRetry,
          { stats },
        );
        if (deeper) return deeper;
      }
      return [subSegment];
    });
    subSegments = expanded.flat();
  }

  return subSegments;
}

async function refineOversizedRanges(
  runtime,
  groups,
  sentenceTexts,
  callLLMWithRetry,
  { primaryChunkCount = 0 } = {},
) {
  // One metrics sample per call, including the no-oversize early return: that
  // is the denominator for deciding whether resplit still pays for itself.
  const stats = createResplitRunStats();
  stats.primaryChunkCount = primaryChunkCount;
  stats.groupCountBefore = groups.length;
  stats.groupCountAfter = groups.length;
  let cancelled = false;
  let completed = false;
  try {
    const refined = await refineOversizedRangesWithStats(
      runtime,
      groups,
      sentenceTexts,
      callLLMWithRetry,
      stats,
    );
    completed = true;
    return refined;
  } catch (error) {
    cancelled = isCancellationError(error, runtime);
    throw error;
  } finally {
    // Awaited like every recordParserMetric call in this file: the service
    // worker can be recycled right after this returns, and a dropped sample
    // silently biases the counts the keep/remove decision rests on.
    // A successful refinement can still lose a cancellation race before this
    // terminal metric write. Suppress that superseded sample, while retaining
    // genuine provider failures that arrived after abort (`completed` is false
    // for those and `cancelled` deliberately remains false).
    const cancelledAfterSuccess = completed && runtime.signal?.aborted;
    if (!cancelled && !cancelledAfterSuccess) await recordResplitRun(stats);
  }
}

async function refineOversizedRangesWithStats(
  runtime,
  groups,
  sentenceTexts,
  callLLMWithRetry,
  stats,
) {
  const segments = [];
  for (const group of groups) {
    for (const range of group.ranges) {
      segments.push({ label: group.label, start: range.start, end: range.end });
    }
  }
  segments.sort((a, b) => a.start - b.start);

  const spans = segments.map((segment) => segment.end - segment.start + 1);
  stats.segmentCount = segments.length;
  stats.maxSpan = spans.length ? Math.max(...spans) : 0;

  const oversized = segments.filter(
    (segment) => segment.end - segment.start + 1 > TOPIC_RANGE_MAX_SENTENCES,
  );
  stats.oversizeCount = oversized.length;
  stats.oversizeSpans = oversized.map((segment) => segment.end - segment.start + 1);
  if (!oversized.length) return groups;

  await runtime.log(
    'topic_ranges_oversize_detected',
    {
      oversizeCount: oversized.length,
      maxSentences: TOPIC_RANGE_MAX_SENTENCES,
      spans: oversized.map((segment) => segment.end - segment.start + 1),
    },
    { verbose: true },
  );

  let changed = false;
  const refinedParts = await parallelMap(segments, TOPIC_RANGE_CONCURRENCY, async (segment) => {
    if (segment.end - segment.start + 1 > TOPIC_RANGE_MAX_SENTENCES) {
      const subSegments = await resplitSegment(
        runtime,
        segment,
        sentenceTexts,
        0,
        callLLMWithRetry,
        { stats },
      );
      if (subSegments && subSegments.length > 1) {
        changed = true;
        return subSegments;
      }
    }
    return [segment];
  });

  if (!changed) return groups;
  stats.changed = true;

  const regrouped = groupsFromSegments(refinedParts.flat(), sentenceTexts.length);
  stats.groupCountAfter = regrouped.length;
  await runtime.log(
    'topic_ranges_oversize_refined',
    {
      groupCountBefore: groups.length,
      groupCountAfter: regrouped.length,
    },
    { verbose: true },
  );
  return regrouped;
}

/**
 * Cleans the HTML, splits sentences, and runs the LLM topic-ranges stage.
 * Returns topics:null when no sentences were found and the record was finalized.
 *
 * @param {object} input
 * @param {PipelineRuntime} input.runtime
 * @param {object} input.record
 * @param {Function} input.callLLMWithRetry
 */
export async function computeTopics({ runtime, record, callLLMWithRetry }) {
  await runtime.update({
    status: PIPELINE_STATUS.SPLITTING,
    progress: { stage: PIPELINE_STAGE.CLEANING_HTML, done: 0, total: 0 },
    error: null,
    topics: [],
    topic_summaries: {},
    topic_summary_index: {},
    source_summary_units: {},
    // A full topic recompute invalidates every path-scoped review decision
    // from the previous tree. Clear them in storage as well as in the current
    // orchestrator invocation so a later park/retry cannot reactivate stale
    // accepted paths against the newly derived tree.
    summaryErrors: [],
    forceFinalize: false,
    acceptedMergeFailurePaths: [],
    summaryCheckpointContentRevision: null,
    summaryCheckpointPreferContentLanguage: null,
    summariesDisabled: false,
    summariesIncomplete: false,
  });
  await runtime.log(
    'cleaning_html_start',
    { htmlLength: String(record.html || '').length },
    { verbose: true },
  );

  const { text, mapping } = stripTagsKeepOffsets(record.html || '');
  await runtime.log(
    'cleaning_html_done',
    { textLength: text.length, mappingLength: mapping.length },
    { verbose: true },
  );

  await runtime.update({
    text,
    progress: { stage: PIPELINE_STAGE.SPLITTING_SENTENCES, done: 0, total: 0 },
  });
  await runtime.log('splitting_sentences_start', {}, { verbose: true });

  const sentenceObjs = splitSentences(text);
  const sentenceTexts = sentenceObjs.map((sentence) => sentence.text);
  await runtime.log(
    'splitting_sentences_done',
    { sentenceCount: sentenceTexts.length },
    { verbose: true },
  );

  const chunks = chunkTopicRangeSentences(
    sentenceTexts,
    runtime.maxTextChunkChars,
    runtime.maxTopicRangeSentences,
  );
  const checkpoint = readTopicRangeChunkCheckpoint(record, chunks);

  await runtime.update({
    sentences: sentenceTexts,
    progress: { stage: PIPELINE_STAGE.TOPIC_RANGES, done: 0, total: sentenceTexts.length },
    // A checkpoint that cannot be proven to describe these sentences is dead
    // weight. Drop it in this write, which already touches the content doc,
    // rather than paying for a second one.
    ...(record?.topic_range_chunks && !checkpoint ? { topic_range_chunks: null } : {}),
  });

  if (sentenceTexts.length === 0) {
    await runtime.update({
      status: PIPELINE_STATUS.DONE,
      topics: [],
      topic_summaries: {},
      summariesDisabled: runtime.summariesDisabled,
      progress: { stage: PIPELINE_STAGE.DONE, done: 0, total: 0 },
    });
    return { topics: null, sentenceTexts };
  }

  await runtime.log(
    'topic_ranges_start',
    {
      taggedLength: chunks.reduce((sum, chunk) => sum + chunk.tagged.length, 0),
      chunkCount: chunks.length,
      maxSentencesPerChunk: runtime.maxTopicRangeSentences,
      resumedChunkCount: checkpoint?.reusedChunkCount || 0,
    },
    { verbose: true },
  );
  if (checkpoint) {
    await runtime.log('topic_ranges_resume_chunks', {
      resumedChunkCount: checkpoint.reusedChunkCount,
      chunkCount: chunks.length,
    });
  }

  // Chunk-level state is the unit of work for the whole stage: a chunk with
  // `segments` set is DONE and is never dispatched or parsed again, in this
  // attempt or any later one. Everything below — the retry scope, the failure
  // aggregate, the persisted checkpoint — is derived from it, so a single bad
  // chunk costs one request per retry instead of re-running the whole article.
  const chunkStates = chunks.map((chunk, chunkIndex) => ({
    chunk,
    chunkIndex,
    segments: checkpoint?.segments[chunkIndex] ?? null,
    response: null,
    dispatchError: null,
    parseError: null,
  }));
  const pendingChunkStates = () => chunkStates.filter((state) => state.segments === null);

  let parseAttempt = 1;
  const failedChunkIndexes = new Set();
  let groups;
  try {
    groups = await queryTopicRangesWithRetry({
      maxRetries: TOPIC_RANGE_STAGE_MAX_RETRIES,
      baseDelayMs: TOPIC_RANGE_RETRY_BASE_DELAY_MS,
      isRetryable: (error) =>
        error instanceof TopicRangeChunkError ? error.retryable : error instanceof TopicParseError,
      // A 429 that exhausted callLLMWithRetry arrives here still carrying the
      // provider's Retry-After. Sleeping the plain 2/4/8s schedule would
      // re-dispatch inside that cooldown, extending the rate limit and turning
      // a recoverable article into an ERROR — so wait out whichever is longer.
      computeDelay: ({ attemptIndex, baseDelayMs, error }) =>
        Math.max(computeBackoffDelay(attemptIndex, baseDelayMs), providerCooldownMs(error)),
      callLLM: async (attemptIndex) => {
        parseAttempt = attemptIndex + 1;
        const pending = pendingChunkStates();
        if (attemptIndex > 0) {
          const retried = capForLog(pending.map((state) => state.chunkIndex));
          await runtime.log('topic_ranges_retry_scope', {
            attempt: parseAttempt,
            retriedChunkCount: pending.length,
            completedChunkCount: chunks.length - pending.length,
            chunkCount: chunks.length,
            retriedChunkIndexes: retried.values,
            retriedChunkIndexesTruncated: retried.truncated,
          });
        }
        await dispatchPendingChunks({
          runtime,
          callLLMWithRetry,
          pending,
          attempt: parseAttempt,
        });
        return pending;
      },
      parse: async (dispatched) => {
        // Do not count a response that lost a cancellation race as a parser
        // attempt for the active pipeline.
        throwIfCancelled(runtime, ABORT_MESSAGE);
        await parseDispatchedChunks({
          runtime,
          dispatched,
          attempt: parseAttempt,
          failedChunkIndexes,
        });
        // A successful chunk is durable before a retry backoff (and before
        // the later refinement/topic write).  If the service worker is
        // terminated while another chunk is being retried, the next run can
        // restore every parsed sibling instead of paying for it again.
        await saveTopicRangeChunkCheckpoint(runtime, record, chunkStates, sentenceTexts.length);
        throwIfCancelled(runtime, ABORT_MESSAGE);
        const failed = pendingChunkStates();
        if (failed.length > 0) throw buildChunkFailureError(failed, chunks.length);
        throwIfCancelled(runtime, ABORT_MESSAGE);
        return groupsFromSegments(
          chunkStates.flatMap((state) => state.segments),
          sentenceTexts.length,
        );
      },
      onParseRetry: ({ attemptNumber, maxRetries, error }) =>
        runtime.log('topic_ranges_parse_retry', {
          attempt: attemptNumber,
          maxRetries,
          retryingChunkCount: pendingChunkStates().length,
          chunkCount: chunks.length,
          // The capped value the stage will honor, not the raw header: logging
          // a 24h Retry-After next to a 60s sleep only misleads whoever is
          // debugging the rate-limit incident.
          providerCooldownMs: providerCooldownMs(error) || null,
          error: error.message,
        }),
    });
  } catch (error) {
    await saveTopicRangeChunkCheckpoint(runtime, record, chunkStates, sentenceTexts.length, error);
    throw error;
  }

  try {
    groups = await refineOversizedRanges(runtime, groups, sentenceTexts, callLLMWithRetry, {
      // Baseline the resplit cost against what the primary stage already spent
      // on the same article; both share LLM_TASK_TYPES.TOPIC_RANGES, so the
      // general LLM metrics cannot tell them apart.
      primaryChunkCount: chunks.length,
    });
  } catch (error) {
    // Oversize refinement is best-effort — the unrefined groups are still
    // usable — but a cancellation must propagate instead of being swallowed
    // here and letting a superseded run continue to topic building.
    rethrowIfCancelled(error, runtime, ABORT_MESSAGE);
    await runtime.log('topic_ranges_oversize_error', {
      error: (error && error.message) || String(error),
    });
  }

  await runtime.log('topic_ranges_done', { groupCount: groups.length }, { verbose: true });

  const topics = groupsToTopics(groups, sentenceObjs, mapping);
  await runtime.update({
    topics,
    // The chunk checkpoint has served its purpose; clearing it here rides along
    // on a content write that was happening anyway, so a healthy run pays
    // nothing for it and no stale segments outlive the topics they produced.
    topic_range_chunks: null,
    // Topics and sentences are now a resumable checkpoint for exactly the
    // content revision read by this run. A later submission bumps
    // contentRevision, so Retry cannot mistake these topics for the new HTML.
    summaryCheckpointContentRevision: record.contentRevision,
    summaryCheckpointPreferContentLanguage: runtime.preferContentLanguage === true,
    status: PIPELINE_STATUS.SUMMARIZING,
    progress: { stage: PIPELINE_STAGE.SUMMARIZING_TOPICS, done: 0, total: topics.length },
  });

  return { topics, sentenceTexts };
}
