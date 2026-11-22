import { errorMessage } from '../../shared/runtime/errorMessage.js';
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
import { rethrowIfCancelled, throwIfCancelled, TOPIC_RANGE_ABORT_MESSAGE } from './cancellation.js';
import { isPermanentProviderError } from './providerFailure.js';
import { runProviderBurst } from './providerBurst.js';

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
  const retryable = failedStates.every((state) => state.failure?.retryable !== false);
  const chunkIndexes = failedStates.map((state) => state.chunkIndex);
  const errors = failedStates.map((state) => (state.failure ? state.failure.error : null));
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

async function dispatchChunk({
  runtime,
  callLLMWithRetry,
  chunk,
  chunkIndex,
  attempt,
  parentPath,
}) {
  const prompt = buildTopicRangesPrompt(chunk.tagged, {
    preferContentLanguage: runtime.preferContentLanguage,
    splittingInstructions: runtime.splittingInstructions,
    resplitParentPath: parentPath,
  });
  await runtime.log(
    'topic_ranges_llm_request',
    { chunkIndex, promptLength: prompt.length, attempt },
    { verbose: true },
  );
  let response;
  try {
    response = await callLLMWithRetry(
      {
        prompt,
        signal: runtime.signal,
        // Manual resplits are measured apart from primary LLM splitting.
        taskType: parentPath ? LLM_TASK_TYPES.TOPIC_RESPLIT : LLM_TASK_TYPES.TOPIC_RANGES,
      },
      TOPIC_RANGE_PROVIDER_MAX_ATTEMPTS,
    );
  } catch (error) {
    rethrowIfCancelled(error, runtime, TOPIC_RANGE_ABORT_MESSAGE);
    await runtime.log('topic_ranges_llm_error', {
      chunkIndex,
      attempt,
      error: errorMessage(error),
    });
    return { error };
  }
  await runtime.log(
    'topic_ranges_llm_response',
    { chunkIndex, responseLength: response.length, attempt },
    { verbose: true },
  );
  return { response };
}

async function parseDispatchedChunk(runtime, chunk, response, logContext) {
  try {
    const { groups, diagnostics } = parseTopicRangesDetailed(response, chunk.sentenceCount);
    if (hasDiagnosticQuirks(diagnostics)) {
      await logParseDiagnostics(runtime, logContext, { diagnostics, response });
    }
    const segments = groups.flatMap((group) =>
      group.ranges.map((range) => ({
        label: group.label,
        start: range.start + chunk.start,
        end: range.end + chunk.start,
      })),
    );
    return { segments, diagnostics };
  } catch (error) {
    rethrowIfCancelled(error, runtime, TOPIC_RANGE_ABORT_MESSAGE);
    return { error, diagnostics: error?.diagnostics || {} };
  }
}

function createSplitProgress({
  runtime,
  chunks,
  checkpoint,
  sentenceCount,
  saveCheckpoint,
  recordParserMetric,
  scope,
}) {
  const requests = chunks.map((chunk, chunkIndex) => ({ chunk, chunkIndex }));
  const states = requests.map(({ chunkIndex }) => ({
    chunkIndex,
    segments: checkpoint?.segments[chunkIndex] ?? null,
    failure: null,
    hadParseFailure: false,
  }));
  const pendingRequests = () =>
    requests.filter(({ chunkIndex }) => states[chunkIndex].segments === null);

  // Serialize parsing and saves. Awaiting saves also bounds dispatch by storage throughput.
  let completion = Promise.resolve();
  let stopped;
  function persistCheckpoint(error) {
    if (!saveCheckpoint) return;
    const snapshot = {
      sentenceCount,
      chunks: states.map(({ chunkIndex, segments }) => {
        if (segments === null) return null;
        const { start, sentenceCount: chunkSize } = chunks[chunkIndex];
        return {
          start,
          sentenceCount: chunkSize,
          segments: segments.map(({ label, start, end }) => ({ label: [...label], start, end })),
        };
      }),
    };
    return saveCheckpoint(snapshot, error);
  }

  return {
    pendingRequests,
    recordDispatchFailure(chunkIndex, error) {
      if (stopped) throw stopped.error;
      states[chunkIndex].failure = { error, retryable: !isPermanentProviderError(error) };
    },
    completeResponse({ chunk, chunkIndex }, response, attempt) {
      if (stopped) throw stopped.error;
      completion = completion.then(async () => {
        throwIfCancelled(runtime, TOPIC_RANGE_ABORT_MESSAGE);
        const state = states[chunkIndex];
        const logContext = { scope, attempt, chunkIndex, sentenceStart: chunk.start };
        const result = await parseDispatchedChunk(runtime, chunk, response, logContext);
        const { diagnostics } = result;
        if (Object.hasOwn(result, 'error')) {
          const { error } = result;
          const retryable = error instanceof TopicParseError;
          state.failure = { error, retryable };
          state.hadParseFailure ||= retryable;
          await recordParserMetric({
            ok: false,
            scope,
            attempt,
            diagnostics,
            error: error?.message,
          });
          if (retryable) await logParseDiagnostics(runtime, logContext, { diagnostics, response });
          return;
        }
        state.segments = result.segments;
        state.failure = null;
        throwIfCancelled(runtime, TOPIC_RANGE_ABORT_MESSAGE);
        await recordParserMetric({
          ok: true,
          scope,
          attempt,
          recoveredAfterRetry: state.hadParseFailure,
          diagnostics,
        });
        await persistCheckpoint();
      });
      return completion;
    },
    groups() {
      throwIfCancelled(runtime, TOPIC_RANGE_ABORT_MESSAGE);
      const failed = states.filter((state) => state.segments === null);
      if (failed.length > 0) throw buildChunkFailureError(failed, states.length);
      return groupsFromSegments(
        states.flatMap((state) => state.segments),
        sentenceCount,
      );
    },
    async saveFailure(error) {
      stopped = { error };
      // Only responses already queued can finish before the terminal snapshot.
      await completion.catch(() => {});
      await persistCheckpoint(error);
    },
  };
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
 * @param {Function} [input.saveCheckpoint] Persists a detached snapshot of completed chunks.
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
  saveCheckpoint,
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

  const progress = createSplitProgress({
    runtime,
    chunks,
    checkpoint,
    sentenceCount: sentenceTexts.length,
    saveCheckpoint,
    recordParserMetric: dependencies.recordParserMetric,
    scope,
  });
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
        const attempt = attemptIndex + 1;
        const pending = progress.pendingRequests();
        if (attemptIndex > 0) {
          const retried = capForLog(pending.map(({ chunkIndex }) => chunkIndex));
          await runtime.log('topic_ranges_retry_scope', {
            attempt,
            retriedChunkCount: pending.length,
            completedChunkCount: chunks.length - pending.length,
            chunkCount: chunks.length,
            retriedChunkIndexes: retried.values,
            retriedChunkIndexesTruncated: retried.truncated,
          });
        }
        const { permanentError, unclaimed } = await runProviderBurst(
          pending,
          TOPIC_RANGE_CONCURRENCY,
          async ({ item }) => {
            const { chunk, chunkIndex } = item;
            const outcome = await dispatchChunk({
              runtime,
              callLLMWithRetry,
              chunk,
              chunkIndex,
              attempt,
              parentPath,
            });
            if (Object.hasOwn(outcome, 'error')) {
              progress.recordDispatchFailure(chunkIndex, outcome.error);
              return outcome;
            }
            await progress.completeResponse(item, outcome.response, attempt);
            return {};
          },
          { parallelMap: dependencies.parallelMap },
        );
        if (permanentError && unclaimed.length > 0) {
          for (const { chunkIndex } of unclaimed) {
            progress.recordDispatchFailure(chunkIndex, permanentError);
          }
          const skippedIndexes = capForLog(unclaimed.map(({ chunkIndex }) => chunkIndex));
          await runtime.log('topic_ranges_llm_skipped', {
            attempt,
            skippedChunkCount: unclaimed.length,
            skippedChunkIndexes: skippedIndexes.values,
            skippedChunkIndexesTruncated: skippedIndexes.truncated,
            error: permanentError.message || String(permanentError),
          });
        }
      },
      parse: progress.groups,
      onParseRetry: ({ attemptNumber, maxRetries, error }) =>
        runtime.log('topic_ranges_parse_retry', {
          attempt: attemptNumber,
          maxRetries,
          retryingChunkCount: progress.pendingRequests().length,
          chunkCount: chunks.length,
          // Log the capped cooldown actually honored by this stage.
          providerCooldownMs: providerCooldownMs(error) || null,
          error: error.message,
        }),
    });
  } catch (error) {
    await progress.saveFailure(error);
    throw error;
  }

  await runtime.log('topic_ranges_done', { groupCount: groups.length }, { verbose: true });
  return groups;
}
