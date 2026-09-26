import { buildTopicRangesPrompt } from './prompts.js';
import { parseTopicRangesDetailed, groupsFromSegments, TopicParseError } from './topicParser.js';
import {
  capForLog,
  compactIndexRanges,
  hasDiagnosticQuirks,
  logParseDiagnostics,
} from './topicRangeDiagnosticsLog.js';
import { chunkTopicRangeSentences } from './topicRangeChunking.js';
import { createTopicRangeDependencies } from './topicRangeDependencies.js';
import { LLM_TASK_TYPES } from '../metrics/llm.js';
import { computeBackoffDelay, queryTopicRangesWithRetry } from './topicRangeRetry.js';
import {
  TOPIC_RANGE_CONCURRENCY,
  TOPIC_RANGE_PROVIDER_MAX_ATTEMPTS,
  TOPIC_RANGE_STAGE_MAX_RETRIES,
} from './pipelineConfig.js';
import { rethrowIfCancelled, throwIfCancelled } from './cancellation.js';
import { isPermanentProviderError } from './providerFailure.js';
import { runProviderBurst } from './providerBurst.js';
import { TOPIC_RANGE_ABORT_MESSAGE } from './topicRangeCheckpoint.js';

const TOPIC_RANGE_RETRY_BASE_DELAY_MS = 2000;
// Same ceiling callLLMWithRetry applies to a provider's Retry-After, so a
// hostile or misconfigured header cannot park the stage indefinitely.
const MAX_PROVIDER_COOLDOWN_MS = 60_000;

/**
 * Aggregate failure for the topic-ranges stage: one or more chunks did not
 * produce parsed segments this attempt. It carries the per-chunk detail so
 * the retry loop can re-request only those chunks, and a single `retryable`
 * verdict so a permanently-failing chunk (a 401, a malformed request) aborts
 * the stage immediately instead of burning three more backoff rounds — no
 * amount of retrying can complete coverage without it.
 */
class TopicRangeChunkError extends Error {
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
 * @param {number} chunkCount Total chunk count for this split.
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
 * chunk, so parallelMap's fail-fast does not discard the responses its
 * siblings already paid for; cancellation still stops the whole burst, since
 * nothing a superseded run produced is wanted.
 *
 * A PERMANENT failure (401, unknown model) is the exception: it condemns every
 * sibling too, so it stops the burst from claiming further chunks. The chunks
 * that were never claimed inherit that error, which keeps them pending, keeps
 * the aggregate non-retryable, and keeps the parser away from their absent
 * responses.
 */
async function dispatchPendingChunks({
  runtime,
  callLLMWithRetry,
  pending,
  attempt,
  dependencies,
  parentPath,
  onResponse,
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
        resplitParentPath: parentPath,
      });
      await runtime.log(
        'topic_ranges_llm_request',
        { chunkIndex: state.chunkIndex, promptLength: prompt.length, attempt },
        { verbose: true },
      );
      try {
        // Each worker owns exactly one state.
        // eslint-disable-next-line require-atomic-updates
        state.response = await callLLMWithRetry(
          {
            prompt,
            signal: runtime.signal,
            taskType: LLM_TASK_TYPES.TOPIC_RANGES,
          },
          TOPIC_RANGE_PROVIDER_MAX_ATTEMPTS,
        );
      } catch (error) {
        rethrowIfCancelled(error, runtime, TOPIC_RANGE_ABORT_MESSAGE);
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
      await onResponse(state);
      return {};
    },
    { parallelMap: dependencies.parallelMap },
  );
  if (!permanentError || skipped.length === 0) return;
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

async function parseDispatchedChunk({
  runtime,
  state,
  attempt,
  failedChunkIndexes,
  dependencies,
  scope,
}) {
  const { recordParserMetric } = dependencies;
  if (state.dispatchError) return;
  const { chunk, chunkIndex, response } = state;
  const logContext = { scope, attempt, chunkIndex, sentenceStart: chunk.start };
  let diagnostics;
  try {
    const parsed = parseTopicRangesDetailed(response, chunk.sentenceCount);
    diagnostics = parsed.diagnostics;
    if (hasDiagnosticQuirks(diagnostics)) {
      await logParseDiagnostics(runtime, logContext, { diagnostics, response });
    }
    // Each completion callback owns exactly one state.
    // eslint-disable-next-line require-atomic-updates
    state.segments = parsed.groups.flatMap((group) =>
      group.ranges.map((range) => ({
        label: group.label,
        start: range.start + chunk.start,
        end: range.end + chunk.start,
      })),
    );
  } catch (error) {
    rethrowIfCancelled(error, runtime, TOPIC_RANGE_ABORT_MESSAGE);
    // eslint-disable-next-line require-atomic-updates
    state.parseError = error;
    const errorDiagnostics = error?.diagnostics || {};
    // One failure sample per failed CHUNK, not per attempt: a sibling's
    // success is kept, so an attempt no longer maps to a single parse outcome.
    await recordParserMetric({
      ok: false,
      scope,
      attempt,
      diagnostics: errorDiagnostics,
      error: error?.message,
    });
    if (error instanceof TopicParseError) {
      failedChunkIndexes.add(chunkIndex);
      await logParseDiagnostics(runtime, logContext, {
        diagnostics: errorDiagnostics,
        response,
      });
    }
    return;
  }
  throwIfCancelled(runtime, TOPIC_RANGE_ABORT_MESSAGE);
  await recordParserMetric({
    ok: true,
    scope,
    attempt,
    recoveredAfterRetry: failedChunkIndexes.has(chunkIndex),
    diagnostics,
  });
}

/**
 * Run the common sentence-to-topic-range stage. Returned ranges use local,
 * zero-based sentence indexes. Callers own sentence preparation and applying
 * the result to their records.
 *
 * @param {object} input
 * @param {object} input.runtime Pipeline runtime.
 * @param {string[]} input.sentenceTexts Prepared sentences for this split.
 * @param {Function} input.callLLMWithRetry Provider call.
 * @param {object} [input.dependencies] Execution and telemetry overrides.
 * @param {string} [input.parentPath] Hierarchy context for a manual split.
 * @param {number} [input.maxTextChunkChars] Maximum tagged text per request.
 * @param {Function} [input.readCheckpoint] Reads reusable segments for these chunks.
 * @param {Function} [input.saveCheckpoint] Persists completed chunk states.
 * @param {Function} [input.onPrepared] Called after chunk and checkpoint preparation.
 * @returns {Promise<object[]>} Parsed groups with local sentence ranges.
 */
export async function splitTopicRanges({
  runtime,
  sentenceTexts,
  callLLMWithRetry,
  dependencies: overrides,
  parentPath = '',
  maxTextChunkChars = runtime.maxTextChunkChars,
  readCheckpoint = () => null,
  saveCheckpoint = async () => {},
  onPrepared = () => {},
}) {
  const dependencies = createTopicRangeDependencies(overrides);
  const scope = parentPath ? 'resplit' : 'primary';
  const chunks = chunkTopicRangeSentences(
    sentenceTexts,
    maxTextChunkChars,
    runtime.maxTopicRangeSentences,
  );
  const checkpoint = readCheckpoint(chunks);
  await onPrepared(chunks, checkpoint);
  if (sentenceTexts.length === 0) return [];

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
  // chunk costs one request per retry instead of re-running the whole split.
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
  // Serialize parsing and saves so an older snapshot cannot overwrite a newer
  // one. Workers await earlier completions plus their own, bounding the queue
  // by provider concurrency while applying storage backpressure to dispatch.
  // Keep rejections terminal: callLLM errors escape the retry helper; only
  // recorded chunk failures reach its retryable parse callback.
  let chunkCompletion = Promise.resolve();
  let stageError;
  const completeChunk = (state) => {
    if (stageError) return Promise.reject(stageError);
    chunkCompletion = chunkCompletion.then(async () => {
      throwIfCancelled(runtime, TOPIC_RANGE_ABORT_MESSAGE);
      await parseDispatchedChunk({
        runtime,
        state,
        attempt: parseAttempt,
        failedChunkIndexes,
        dependencies,
        scope,
      });
      if (state.segments !== null) {
        await saveCheckpoint(chunkStates, sentenceTexts.length);
      }
    });
    return chunkCompletion;
  };
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
          parentPath,
          onResponse: completeChunk,
        });
      },
      parse: async () => {
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
    stageError = error;
    // Dispatch can fail while a completion is in flight. Drain it before the
    // final best-effort save; late responses cannot enqueue more writes.
    await chunkCompletion.catch(() => {});
    await saveCheckpoint(chunkStates, sentenceTexts.length, error);
    throw error;
  }

  await runtime.log('topic_ranges_done', { groupCount: groups.length }, { verbose: true });
  return groups;
}
