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
import { queryTopicRangesWithRetry } from './topicRangeRetry.js';
import { MAX_TAGGED_CHARS } from './pipelineConfig.js';
import { PIPELINE_STAGE, PIPELINE_STATUS } from '../../src/shared/runtime/contracts.js';

const TOPIC_RANGE_CONCURRENCY = 4;
const TOPIC_RANGE_TEMPERATURE = 0.2;
const TOPIC_RANGE_MAX_RETRIES = 3;
const TOPIC_RANGE_RETRY_BASE_DELAY_MS = 2000;
const TOPIC_RANGE_MAX_SENTENCES = 40;
const TOPIC_RANGE_INPUT_MAX_SENTENCES = 240;
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

export function chunkTaggedText(tagged, maxChars) {
  const lines = tagged.split('\n');
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
      const line = `{${lines.length}} ${sentence ?? ''}`;
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
  const chunks =
    tagged.length > MAX_TAGGED_CHARS ? chunkTaggedText(tagged, MAX_TAGGED_CHARS) : [tagged];

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
        const responses = await parallelMap(chunks, TOPIC_RANGE_CONCURRENCY, (chunk) =>
          callLLMWithRetry({
            prompt: buildTopicRangesPrompt(chunk, {
              preferContentLanguage: runtime.preferContentLanguage,
            }),
            temperature: TOPIC_RANGE_TEMPERATURE,
            signal: runtime.signal,
            taskType: LLM_TASK_TYPES.TOPIC_RANGES,
          }),
        );
        return responses.join('\n');
      },
      parse: async (raw) => {
        try {
          const parsed = parseTopicRangesDetailed(raw, sliceTexts.length);
          await recordParserMetric({ ok: true, scope: 'resplit', diagnostics: parsed.diagnostics });
          if (hasDiagnosticQuirks(parsed.diagnostics)) {
            await runtime.log(
              'topic_ranges_parse_diagnostics',
              {
                scope: 'resplit',
                depth,
                start: segment.start,
                end: segment.end,
                ...buildParseDiagnosticsLogDetails(parsed.diagnostics),
              },
              { verbose: true },
            );
            await runtime.log(
              'topic_ranges_raw_response',
              {
                scope: 'resplit',
                depth,
                start: segment.start,
                end: segment.end,
                ...buildRawResponseLogDetails(raw),
              },
              { verbose: true },
            );
          }
          return parsed.groups;
        } catch (error) {
          const diagnostics = { ...error?.diagnostics, sentenceCount: sliceTexts.length };
          await recordParserMetric({
            ok: false,
            scope: 'resplit',
            diagnostics,
            error: error?.message,
          });
          if (error instanceof TopicParseError) {
            await runtime.log(
              'topic_ranges_parse_diagnostics',
              {
                scope: 'resplit',
                depth,
                start: segment.start,
                end: segment.end,
                ...buildParseDiagnosticsLogDetails(diagnostics),
              },
              { verbose: true },
            );
            await runtime.log(
              'topic_ranges_raw_response',
              {
                scope: 'resplit',
                depth,
                start: segment.start,
                end: segment.end,
                ...buildRawResponseLogDetails(raw),
              },
              { verbose: true },
            );
          }
          throw error;
        }
      },
    });
  } catch (error) {
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
  try {
    return await refineOversizedRangesWithStats(
      runtime,
      groups,
      sentenceTexts,
      callLLMWithRetry,
      stats,
    );
  } finally {
    // Awaited like every recordParserMetric call in this file: the service
    // worker can be recycled right after this returns, and a dropped sample
    // silently biases the counts the keep/remove decision rests on.
    await recordResplitRun(stats);
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
    summariesDisabled: false,
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

  await runtime.update({
    sentences: sentenceTexts,
    progress: { stage: PIPELINE_STAGE.TOPIC_RANGES, done: 0, total: sentenceTexts.length },
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

  const chunks = chunkTopicRangeSentences(sentenceTexts);
  await runtime.log(
    'topic_ranges_start',
    {
      taggedLength: chunks.reduce((sum, chunk) => sum + chunk.tagged.length, 0),
      chunkCount: chunks.length,
      maxSentencesPerChunk: TOPIC_RANGE_INPUT_MAX_SENTENCES,
    },
    { verbose: true },
  );

  let parseAttempt = 1;
  const failedChunkIndexes = new Set();
  let groups = await queryTopicRangesWithRetry({
    maxRetries: TOPIC_RANGE_MAX_RETRIES,
    baseDelayMs: TOPIC_RANGE_RETRY_BASE_DELAY_MS,
    isRetryable: (error) => error instanceof TopicParseError,
    callLLM: async (attemptIndex) => {
      parseAttempt = attemptIndex + 1;
      return parallelMap(chunks, TOPIC_RANGE_CONCURRENCY, async (chunk, chunkIndex) => {
        const prompt = buildTopicRangesPrompt(chunk.tagged, {
          preferContentLanguage: runtime.preferContentLanguage,
        });
        await runtime.log(
          'topic_ranges_llm_request',
          { chunkIndex, promptLength: prompt.length, attempt: attemptIndex + 1 },
          { verbose: true },
        );
        const response = await callLLMWithRetry({
          prompt,
          temperature: TOPIC_RANGE_TEMPERATURE,
          signal: runtime.signal,
          taskType: LLM_TASK_TYPES.TOPIC_RANGES,
        });
        await runtime.log(
          'topic_ranges_llm_response',
          { chunkIndex, responseLength: response.length, attempt: attemptIndex + 1 },
          { verbose: true },
        );
        return { chunk, chunkIndex, response };
      });
    },
    parse: async (responses) => {
      let activeResponse = null;
      try {
        const segments = [];
        const successfulMetricSamples = [];
        for (const { chunk, chunkIndex, response } of responses) {
          activeResponse = { chunk, chunkIndex, response };
          const parsed = parseTopicRangesDetailed(response, chunk.sentenceCount);
          successfulMetricSamples.push({
            ok: true,
            scope: 'primary',
            attempt: parseAttempt,
            recoveredAfterRetry: failedChunkIndexes.has(chunkIndex),
            diagnostics: parsed.diagnostics,
          });
          if (hasDiagnosticQuirks(parsed.diagnostics)) {
            await runtime.log(
              'topic_ranges_parse_diagnostics',
              {
                scope: 'primary',
                attempt: parseAttempt,
                chunkIndex,
                sentenceStart: chunk.start,
                ...buildParseDiagnosticsLogDetails(parsed.diagnostics),
              },
              { verbose: true },
            );
            await runtime.log(
              'topic_ranges_raw_response',
              {
                scope: 'primary',
                attempt: parseAttempt,
                chunkIndex,
                sentenceStart: chunk.start,
                ...buildRawResponseLogDetails(response),
              },
              { verbose: true },
            );
          }
          for (const group of parsed.groups) {
            for (const range of group.ranges) {
              segments.push({
                label: group.label,
                start: range.start + chunk.start,
                end: range.end + chunk.start,
              });
            }
          }
        }
        const parsedGroups = groupsFromSegments(segments, sentenceTexts.length);
        for (const sample of successfulMetricSamples) await recordParserMetric(sample);
        return parsedGroups;
      } catch (error) {
        const diagnostics = error?.diagnostics || {};
        if (error instanceof TopicParseError && activeResponse) {
          failedChunkIndexes.add(activeResponse.chunkIndex);
        }
        await recordParserMetric({
          ok: false,
          scope: 'primary',
          attempt: parseAttempt,
          diagnostics,
          error: error?.message,
        });
        if (error instanceof TopicParseError) {
          await runtime.log(
            'topic_ranges_parse_diagnostics',
            {
              scope: 'primary',
              attempt: parseAttempt,
              chunkIndex: activeResponse?.chunkIndex,
              sentenceStart: activeResponse?.chunk.start,
              ...buildParseDiagnosticsLogDetails(diagnostics),
            },
            { verbose: true },
          );
          await runtime.log(
            'topic_ranges_raw_response',
            {
              scope: 'primary',
              attempt: parseAttempt,
              chunkIndex: activeResponse?.chunkIndex,
              sentenceStart: activeResponse?.chunk.start,
              ...buildRawResponseLogDetails(activeResponse?.response),
            },
            { verbose: true },
          );
        }
        throw error;
      }
    },
    onParseRetry: ({ attemptNumber, maxRetries, error }) =>
      runtime.log('topic_ranges_parse_retry', {
        attempt: attemptNumber,
        maxRetries,
        error: error.message,
      }),
  });

  try {
    groups = await refineOversizedRanges(runtime, groups, sentenceTexts, callLLMWithRetry, {
      // Baseline the resplit cost against what the primary stage already spent
      // on the same article; both share LLM_TASK_TYPES.TOPIC_RANGES, so the
      // general LLM metrics cannot tell them apart.
      primaryChunkCount: chunks.length,
    });
  } catch (error) {
    await runtime.log('topic_ranges_oversize_error', {
      error: (error && error.message) || String(error),
    });
  }

  await runtime.log('topic_ranges_done', { groupCount: groups.length }, { verbose: true });

  const topics = groupsToTopics(groups, sentenceObjs, mapping);
  await runtime.update({
    topics,
    status: PIPELINE_STATUS.SUMMARIZING,
    progress: { stage: PIPELINE_STAGE.SUMMARIZING_TOPICS, done: 0, total: topics.length },
  });

  return { topics, sentenceTexts };
}
