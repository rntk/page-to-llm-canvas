import { normalizePlainTextKeepOffsets, stripTagsKeepOffsets } from './html.js';
import { splitSentences } from './sentenceSplitter.js';
import { buildTopicRangesPrompt } from './prompts.js';
import { parseTopicRangesDetailed, groupsFromSegments, TopicParseError } from './topicParser.js';
import {
  capForLog,
  compactIndexRanges,
  hasDiagnosticQuirks,
  logParseDiagnostics,
} from './topicRangeDiagnosticsLog.js';
import { chunkTopicRangeSentences } from './topicRangeChunking.js';
import { groupsToTopics } from './topicRangeMapping.js';
import { createTopicRangeDependencies } from './topicRangeDependencies.js';
import { refineOversizedRanges } from './topicRangeResplit.js';
import { LLM_TASK_TYPES } from '../metrics/llm.js';
import { computeBackoffDelay, queryTopicRangesWithRetry } from './topicRangeRetry.js';
import {
  TOPIC_RANGE_CONCURRENCY,
  TOPIC_RANGE_PROVIDER_MAX_ATTEMPTS,
  TOPIC_RANGE_STAGE_MAX_RETRIES,
  TOPIC_RANGE_TEMPERATURE,
} from './pipelineConfig.js';
import { PIPELINE_STAGE, PIPELINE_STATUS } from '../../src/shared/runtime/contracts.js';
import { rethrowIfCancelled, throwIfCancelled } from './cancellation.js';
import { isPermanentProviderError } from './providerFailure.js';
import { runProviderBurst } from './providerBurst.js';
import { TOPIC_RANGE_ABORT_MESSAGE } from './topicRangeCheckpoint.js';

const TOPIC_RANGE_RETRY_BASE_DELAY_MS = 2000;
// Same ceiling callLLMWithRetry applies to a provider's Retry-After, so a
// hostile or misconfigured header cannot park the stage indefinitely.
const MAX_PROVIDER_COOLDOWN_MS = 60_000;

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
async function dispatchPendingChunks({
  runtime,
  callLLMWithRetry,
  pending,
  attempt,
  dependencies,
}) {
  const { permanentError, unclaimed: skipped } = await runProviderBurst(
    pending,
    TOPIC_RANGE_CONCURRENCY,
    async ({ item: state }) => {
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
        rethrowIfCancelled(error, runtime, TOPIC_RANGE_ABORT_MESSAGE);
        // Sole owner of `state`, as above.
        // eslint-disable-next-line require-atomic-updates
        state.dispatchError = error;
        await runtime.log('topic_ranges_llm_error', {
          chunkIndex: state.chunkIndex,
          attempt,
          error: (error && error.message) || String(error),
        });
        return { error };
      }
      await runtime.log(
        'topic_ranges_llm_response',
        { chunkIndex: state.chunkIndex, responseLength: state.response.length, attempt },
        { verbose: true },
      );
      return {};
    },
    { parallelMap: dependencies.parallelMap },
  );
  if (!permanentError) return;
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
async function parseDispatchedChunks({
  runtime,
  dispatched,
  attempt,
  failedChunkIndexes,
  dependencies,
}) {
  const { recordParserMetric } = dependencies;
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
      rethrowIfCancelled(error, runtime, TOPIC_RANGE_ABORT_MESSAGE);
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
    throwIfCancelled(runtime, TOPIC_RANGE_ABORT_MESSAGE);
    await recordParserMetric(sample);
  }
}

/**
 * Cleans the HTML, splits sentences, and runs the LLM topic-ranges stage.
 * Returns topics:null when no sentences were found and the record was finalized.
 *
 * @param {object} input
 * @param {PipelineRuntime} input.runtime
 * @param {object} input.record
 * @param {Function} input.callLLMWithRetry
 * @param {object} [input.dependencies] Telemetry, execution, and checkpoint capabilities.
 */
export async function computeTopics({
  runtime,
  record,
  callLLMWithRetry,
  dependencies: overrides,
}) {
  const dependencies = createTopicRangeDependencies(overrides);
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
  const useCapturedText = record?.captureVersion >= 2 && typeof record?.capturedText === 'string';
  await runtime.log(
    'cleaning_html_start',
    {
      htmlLength: String(record.html || '').length,
      capturedTextLength: useCapturedText ? record.capturedText.length : 0,
      source: useCapturedText ? 'captured_text' : 'html',
    },
    { verbose: true },
  );

  // Version 2 captures text in the page context, while CSS/layout are still
  // available. Treat it as plain text: parsing it as HTML would corrupt
  // literal `<`, `>` and `&` characters (and could reintroduce content that
  // capture-side visibility filtering removed). Legacy records retain the
  // HTML scanner and its HTML-offset mapping.
  const { text, mapping } = useCapturedText
    ? normalizePlainTextKeepOffsets(record.capturedText)
    : stripTagsKeepOffsets(record.html || '');
  await runtime.log(
    'cleaning_html_done',
    {
      textLength: text.length,
      mappingLength: mapping.length,
      source: useCapturedText ? 'captured_text' : 'html',
    },
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
  const checkpoint = dependencies.readCheckpoint(record, chunks);

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
          dependencies,
        });
        return pending;
      },
      parse: async (dispatched) => {
        // Do not count a response that lost a cancellation race as a parser
        // attempt for the active pipeline.
        throwIfCancelled(runtime, TOPIC_RANGE_ABORT_MESSAGE);
        await parseDispatchedChunks({
          runtime,
          dispatched,
          attempt: parseAttempt,
          failedChunkIndexes,
          dependencies,
        });
        // A successful chunk is durable before a retry backoff (and before
        // the later refinement/topic write).  If the service worker is
        // terminated while another chunk is being retried, the next run can
        // restore every parsed sibling instead of paying for it again.
        await dependencies.saveCheckpoint(runtime, record, chunkStates, sentenceTexts.length);
        throwIfCancelled(runtime, TOPIC_RANGE_ABORT_MESSAGE);
        const failed = pendingChunkStates();
        if (failed.length > 0) throw buildChunkFailureError(failed, chunks.length);
        throwIfCancelled(runtime, TOPIC_RANGE_ABORT_MESSAGE);
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
    await dependencies.saveCheckpoint(runtime, record, chunkStates, sentenceTexts.length, error);
    throw error;
  }

  try {
    groups = await refineOversizedRanges(runtime, groups, sentenceTexts, callLLMWithRetry, {
      // Baseline the resplit cost against what the primary stage already spent
      // on the same article; both share LLM_TASK_TYPES.TOPIC_RANGES, so the
      // general LLM metrics cannot tell them apart.
      primaryChunkCount: chunks.length,
      dependencies,
    });
  } catch (error) {
    // Oversize refinement is best-effort — the unrefined groups are still
    // usable — but a cancellation must propagate instead of being swallowed
    // here and letting a superseded run continue to topic building.
    rethrowIfCancelled(error, runtime, TOPIC_RANGE_ABORT_MESSAGE);
    await runtime.log('topic_ranges_oversize_error', {
      error: (error && error.message) || String(error),
    });
  }

  await runtime.log('topic_ranges_done', { groupCount: groups.length }, { verbose: true });

  const topics = groupsToTopics(
    groups,
    sentenceObjs,
    mapping,
    useCapturedText ? 'captured_text' : 'html',
  );
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
