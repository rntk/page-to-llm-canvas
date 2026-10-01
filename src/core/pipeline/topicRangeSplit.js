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
 * Aggregate failed chunks for selective retry. Any permanent chunk failure
 * makes the whole split non-retryable.
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
 * Aggregate missing chunks; retry only when every failure is retryable.
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
  // Preserve any sibling's HTTP classification. Keep originals in `.errors`,
  // not `cause`: cancellation detection walks causes and could misclassify an
  // abort-shaped transport timeout.
  const status = errors.find((error) => Number.isFinite(error?.status))?.status;
  if (status !== undefined) aggregate.status = status;
  // Retries dispatch all failed chunks together, so honor the longest cooldown.
  const cooldowns = errors
    .map((error) => error?.retryAfterMs)
    .filter((ms) => Number.isFinite(ms) && ms > 0);
  if (cooldowns.length > 0) aggregate.retryAfterMs = Math.max(...cooldowns);
  return aggregate;
}

/**
 * Record each pending chunk's result so sibling successes survive provider
 * failures. Cancellation stops the burst. Permanent failures stop claiming
 * chunks and are propagated to unclaimed states.
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
    // Propagate the permanent failure to unclaimed chunks.
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
    // Record one sample per failed chunk; sibling successes are retained.
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

  // Completed chunk states are checkpointed and never dispatched again.
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
  // Serialize parsing and saves to prevent an older snapshot overwriting a
  // newer one. Awaiting saves also bounds dispatch by storage throughput.
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
      // Honor Retry-After when it exceeds the stage backoff.
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
          // Log the capped cooldown actually honored by this stage.
          providerCooldownMs: providerCooldownMs(error) || null,
          error: error.message,
        }),
    });
  } catch (error) {
    stageError = error;
    // Drain in-flight completions before the final checkpoint save.
    await chunkCompletion.catch(() => {});
    await saveCheckpoint(chunkStates, sentenceTexts.length, error);
    throw error;
  }

  await runtime.log('topic_ranges_done', { groupCount: groups.length }, { verbose: true });
  return groups;
}
