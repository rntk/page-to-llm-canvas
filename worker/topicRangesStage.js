import { stripTagsKeepOffsets } from './html.js';
import { splitSentences } from './sentence_splitter.js';
import { buildTaggedText, buildTopicRangesPrompt } from './prompts.js';
import { parseTopicRangesDetailed, groupsFromSegments, TopicParseError } from './topic_parser.js';
import { recordParserMetric } from './parserMetrics.js';
import { parallelMap } from './llm.js';
import { LLM_TASK_TYPES } from './llmMetrics.js';
import { queryTopicRangesWithRetry } from './topicRangeRetry.js';
import { MAX_TAGGED_CHARS } from './pipelineConfig.js';

const TOPIC_RANGE_CONCURRENCY = 4;
const TOPIC_RANGE_TEMPERATURE = 0.2;
const TOPIC_RANGE_MAX_RETRIES = 3;
const TOPIC_RANGE_RETRY_BASE_DELAY_MS = 2000;
const TOPIC_RANGE_MAX_SENTENCES = 40;
const TOPIC_RANGE_RESPLIT_MAX_DEPTH = 2;

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
 * best-effort: a failed or ineffective re-split returns null so its caller can
 * retain the original range.
 */
async function resplitSegment(runtime, segment, sentenceTexts, depth, callLLMWithRetry) {
  const span = segment.end - segment.start + 1;
  const sliceTexts = sentenceTexts.slice(segment.start, segment.end + 1);
  const tagged = buildTaggedText(sliceTexts);
  const chunks =
    tagged.length > MAX_TAGGED_CHARS ? chunkTaggedText(tagged, MAX_TAGGED_CHARS) : [tagged];

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
          return parsed.groups;
        } catch (error) {
          await recordParserMetric({
            ok: false,
            scope: 'resplit',
            diagnostics: { ...error?.diagnostics, sentenceCount: sliceTexts.length },
            error: error?.message,
          });
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

  if (depth + 1 < TOPIC_RANGE_RESPLIT_MAX_DEPTH) {
    const expanded = await parallelMap(subSegments, TOPIC_RANGE_CONCURRENCY, async (subSegment) => {
      if (subSegment.end - subSegment.start + 1 > TOPIC_RANGE_MAX_SENTENCES) {
        const deeper = await resplitSegment(
          runtime,
          subSegment,
          sentenceTexts,
          depth + 1,
          callLLMWithRetry,
        );
        if (deeper) return deeper;
      }
      return [subSegment];
    });
    subSegments = expanded.flat();
  }

  return subSegments;
}

async function refineOversizedRanges(runtime, groups, sentenceTexts, callLLMWithRetry) {
  const segments = [];
  for (const group of groups) {
    for (const range of group.ranges) {
      segments.push({ label: group.label, start: range.start, end: range.end });
    }
  }
  segments.sort((a, b) => a.start - b.start);

  const oversized = segments.filter(
    (segment) => segment.end - segment.start + 1 > TOPIC_RANGE_MAX_SENTENCES,
  );
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
      );
      if (subSegments && subSegments.length > 1) {
        changed = true;
        return subSegments;
      }
    }
    return [segment];
  });

  if (!changed) return groups;

  const regrouped = groupsFromSegments(refinedParts.flat(), sentenceTexts.length);
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
 */
export async function computeTopics(runtime, record, callLLMWithRetry) {
  await runtime.update({
    status: 'splitting',
    progress: { stage: 'cleaning_html', done: 0, total: 0 },
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
    progress: { stage: 'splitting_sentences', done: 0, total: 0 },
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
    progress: { stage: 'topic_ranges', done: 0, total: sentenceTexts.length },
  });

  if (sentenceTexts.length === 0) {
    await runtime.update({
      status: 'done',
      topics: [],
      topic_summaries: {},
      summariesDisabled: runtime.summariesDisabled,
      progress: { stage: 'done', done: 0, total: 0 },
    });
    return { topics: null, sentenceTexts };
  }

  const tagged = buildTaggedText(sentenceTexts);
  const chunks =
    tagged.length > MAX_TAGGED_CHARS ? chunkTaggedText(tagged, MAX_TAGGED_CHARS) : [tagged];
  await runtime.log(
    'topic_ranges_start',
    { taggedLength: tagged.length, chunkCount: chunks.length },
    { verbose: true },
  );

  let parseAttempt = 1;
  let groups = await queryTopicRangesWithRetry({
    maxRetries: TOPIC_RANGE_MAX_RETRIES,
    baseDelayMs: TOPIC_RANGE_RETRY_BASE_DELAY_MS,
    isRetryable: (error) => error instanceof TopicParseError,
    callLLM: async (attemptIndex) => {
      parseAttempt = attemptIndex + 1;
      const responses = await parallelMap(
        chunks,
        TOPIC_RANGE_CONCURRENCY,
        async (chunk, chunkIndex) => {
          const prompt = buildTopicRangesPrompt(chunk, {
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
          return response;
        },
      );
      return responses.join('\n');
    },
    parse: async (combined) => {
      try {
        const parsed = parseTopicRangesDetailed(combined, sentenceTexts.length);
        await recordParserMetric({
          ok: true,
          scope: 'primary',
          attempt: parseAttempt,
          recoveredAfterRetry: parseAttempt > 1,
          diagnostics: parsed.diagnostics,
        });
        return parsed.groups;
      } catch (error) {
        await recordParserMetric({
          ok: false,
          scope: 'primary',
          attempt: parseAttempt,
          diagnostics: { ...error?.diagnostics, sentenceCount: sentenceTexts.length },
          error: error?.message,
        });
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
    groups = await refineOversizedRanges(runtime, groups, sentenceTexts, callLLMWithRetry);
  } catch (error) {
    await runtime.log('topic_ranges_oversize_error', {
      error: (error && error.message) || String(error),
    });
  }

  await runtime.log('topic_ranges_done', { groupCount: groups.length }, { verbose: true });

  const topics = groupsToTopics(groups, sentenceObjs, mapping);
  await runtime.update({
    topics,
    status: 'summarizing',
    progress: { stage: 'summarizing_topics', done: 0, total: topics.length },
  });

  return { topics, sentenceTexts };
}
