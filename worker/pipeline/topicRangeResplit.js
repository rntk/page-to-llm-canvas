import { buildTaggedText, buildTopicRangesPrompt } from './prompts.js';
import { parseTopicRangesDetailed, groupsFromSegments, TopicParseError } from './topicParser.js';
import { RESPLIT_OUTCOMES as DEFAULT_RESPLIT_OUTCOMES } from '../metrics/resplit.js';
import { LLM_TASK_TYPES } from '../metrics/llm.js';
import { queryTopicRangesWithRetry } from './topicRangeRetry.js';
import {
  TOPIC_RANGE_CONCURRENCY,
  TOPIC_RANGE_RESPLIT_PROVIDER_MAX_ATTEMPTS,
} from './pipelineConfig.js';
import { isCancellationError, rethrowIfCancelled, throwIfCancelled } from './cancellation.js';
import { hasDiagnosticQuirks, logParseDiagnostics } from './topicRangeDiagnosticsLog.js';
import { chunkTaggedText } from './topicRangeChunking.js';
import { defaultTopicRangeDependencies } from './topicRangeDependencies.js';
import { TOPIC_RANGE_ABORT_MESSAGE } from './topicRangeCheckpoint.js';

const TOPIC_RANGE_MAX_SENTENCES = 40;
const TOPIC_RANGE_RESPLIT_MAX_DEPTH = 2;

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
  { acceptSingle = false, stats = null, dependencies = defaultTopicRangeDependencies } = {},
) {
  const { noteResplitOutcome } = dependencies;
  const span = segment.end - segment.start + 1;
  const logCtx = { start: segment.start, end: segment.end, span, depth };
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
    { ...logCtx, chunkCount: chunks.length },
    { verbose: true },
  );

  let subGroups;
  try {
    subGroups = await queryTopicRangesWithRetry({
      maxRetries: 0,
      callLLM: async () => {
        const responses = await dependencies.parallelMap(
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
                    signal: runtime.signal,
                    taskType: LLM_TASK_TYPES.TOPIC_RANGES,
                  },
                  TOPIC_RANGE_RESPLIT_PROVIDER_MAX_ATTEMPTS,
                ),
              };
            } catch (error) {
              rethrowIfCancelled(error, runtime, TOPIC_RANGE_ABORT_MESSAGE);
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
          throwIfCancelled(runtime, TOPIC_RANGE_ABORT_MESSAGE);
          const parsed = parseTopicRangesDetailed(raw, sliceTexts.length);
          if (hasDiagnosticQuirks(parsed.diagnostics)) {
            await logParseDiagnostics(runtime, logContext, {
              diagnostics: parsed.diagnostics,
              response: raw,
            });
          }
          throwIfCancelled(runtime, TOPIC_RANGE_ABORT_MESSAGE);
          await dependencies.recordParserMetric({
            ok: true,
            scope: 'resplit',
            diagnostics: parsed.diagnostics,
          });
          return parsed.groups;
        } catch (error) {
          // An AbortError from the boundary check or runtime logging is not a
          // malformed model response and must not become a parser sample.
          rethrowIfCancelled(error, runtime, TOPIC_RANGE_ABORT_MESSAGE);
          const diagnostics = { ...error?.diagnostics, sentenceCount: sliceTexts.length };
          await dependencies.recordParserMetric({
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
    rethrowIfCancelled(error, runtime, TOPIC_RANGE_ABORT_MESSAGE);
    await runtime.log('topic_ranges_resplit_error', {
      start: segment.start,
      end: segment.end,
      depth,
      error: (error && error.message) || String(error),
    });
    noteResplitOutcome(stats, DEFAULT_RESPLIT_OUTCOMES.ERROR);
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
      noteResplitOutcome(stats, DEFAULT_RESPLIT_OUTCOMES.ACCEPTED_SINGLE);
      return subSegments;
    }

    await runtime.log('topic_ranges_resplit_no_progress', { ...logCtx }, { verbose: true });

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
        { ...logCtx, windowCount: windows.length },
        { verbose: true },
      );
      noteResplitOutcome(stats, DEFAULT_RESPLIT_OUTCOMES.WINDOW_FALLBACK);
      const windowResults = await dependencies.parallelMap(
        windows,
        TOPIC_RANGE_CONCURRENCY,
        async (window) =>
          (await resplitSegment(runtime, window, sentenceTexts, depth + 1, callLLMWithRetry, {
            acceptSingle: true,
            stats,
            dependencies,
          })) || [window],
      );
      return windowResults.flat();
    }
    noteResplitOutcome(stats, DEFAULT_RESPLIT_OUTCOMES.NO_PROGRESS);
    return null;
  }

  await runtime.log(
    'topic_ranges_resplit_response',
    { ...logCtx, subSegmentCount: subSegments.length },
    { verbose: true },
  );
  noteResplitOutcome(stats, DEFAULT_RESPLIT_OUTCOMES.SUBDIVIDED);

  if (depth + 1 < TOPIC_RANGE_RESPLIT_MAX_DEPTH) {
    const expanded = await dependencies.parallelMap(
      subSegments,
      TOPIC_RANGE_CONCURRENCY,
      async (subSegment) => {
        if (subSegment.end - subSegment.start + 1 > TOPIC_RANGE_MAX_SENTENCES) {
          const deeper = await resplitSegment(
            runtime,
            subSegment,
            sentenceTexts,
            depth + 1,
            callLLMWithRetry,
            { stats, dependencies },
          );
          if (deeper) return deeper;
        }
        return [subSegment];
      },
    );
    subSegments = expanded.flat();
  }

  return subSegments;
}

export async function refineOversizedRanges(
  runtime,
  groups,
  sentenceTexts,
  callLLMWithRetry,
  { primaryChunkCount = 0, dependencies = defaultTopicRangeDependencies } = {},
) {
  // One metrics sample per call, including the no-oversize early return: that
  // is the denominator for deciding whether resplit still pays for itself.
  const stats = dependencies.createResplitRunStats();
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
      dependencies,
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
    if (!cancelled && !cancelledAfterSuccess) {
      await dependencies.recordResplitRun(stats);
    }
  }
}

async function refineOversizedRangesWithStats(
  runtime,
  groups,
  sentenceTexts,
  callLLMWithRetry,
  stats,
  dependencies = defaultTopicRangeDependencies,
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
  const refinedParts = await dependencies.parallelMap(
    segments,
    TOPIC_RANGE_CONCURRENCY,
    async (segment) => {
      if (segment.end - segment.start + 1 > TOPIC_RANGE_MAX_SENTENCES) {
        const subSegments = await resplitSegment(
          runtime,
          segment,
          sentenceTexts,
          0,
          callLLMWithRetry,
          { stats, dependencies },
        );
        if (subSegments && subSegments.length > 1) {
          changed = true;
          return subSegments;
        }
      }
      return [segment];
    },
  );

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
