// Names fixed sentence ranges with the completion LLM. Ranges come from the
// decision stage; the model only supplies one topic path per range.

import { buildTopicLabelsPrompt } from './prompts.js';
import { groupsFromSegments, TopicParseError } from './topicParser.js';
import { LLM_TASK_TYPES } from '../metrics/llm.js';
import { TOPIC_RANGE_CONCURRENCY, TOPIC_RANGE_STAGE_MAX_RETRIES } from './pipelineConfig.js';
import { rethrowIfCancelled, throwIfCancelled } from './cancellation.js';
import { TOPIC_RANGE_ABORT_MESSAGE } from './topicRangeCheckpoint.js';
import { splitTopicPath } from '../../shared/runtime/topicPath.js';
import { parallelMap as defaultParallelMap } from '../llm/concurrency.js';
import { fitTextToChars } from './topicRangeChunking.js';

// Enough of a section to name it; long sections keep their head and tail.
export const LABEL_SECTION_MAX_CHARS = 1500;
// Bounds the response length of one labeling request.
const LABEL_MAX_SECTIONS = 60;
const LABEL_PROVIDER_MAX_ATTEMPTS = 3;
const LABEL_LINE_RE = /^\W*\[?(\d+)\]?\s*[:.)\]-]\s*(.+)$/u;

function numberSections(bodies) {
  return bodies.map((body, index) => `[${index + 1}]\n${body}`).join('\n');
}

/**
 * Pack whole ranges into requests no larger than `maxChars` of section text.
 * @param {Array<{start: number, end: number}>} ranges Zero-based inclusive ranges.
 * @param {string[]} sentenceTexts Source sentences.
 * @param {number} maxChars Request text budget.
 * @returns {Array<{ranges: object[], bodies: string[], text: string}>}
 */
export function batchRangesForLabels(ranges, sentenceTexts, maxChars) {
  const sectionMaxChars = Math.max(1, Math.min(LABEL_SECTION_MAX_CHARS, maxChars - 8));
  const batches = [];
  let current = null;
  for (const range of ranges) {
    const body = fitTextToChars(
      sentenceTexts
        .slice(range.start, range.end + 1)
        .join(' ')
        .replace(/\s+/gu, ' ')
        .trim(),
      sectionMaxChars,
    );
    const fits =
      current &&
      current.ranges.length < LABEL_MAX_SECTIONS &&
      current.text.length + `\n[${current.ranges.length + 1}]\n${body}`.length <= maxChars;
    if (!fits) {
      current = { ranges: [], bodies: [], text: '' };
      batches.push(current);
    }
    current.ranges.push(range);
    current.bodies.push(body);
    current.text = numberSections(current.bodies);
  }
  return batches;
}

/**
 * Parse "S: path" lines; every section number must be named exactly once.
 * @param {string} response Raw model response.
 * @param {number} sectionCount Sections in the request.
 * @returns {string[][]} Label parts per section.
 * @throws {TopicParseError} With `diagnostics.missing` section numbers and
 *   `diagnostics.labels` holding the parsed labels (null where missing).
 */
export function parseTopicLabels(response, sectionCount) {
  const labels = new Array(sectionCount).fill(null);
  for (const line of String(response).split(/\r?\n/)) {
    const match = LABEL_LINE_RE.exec(line.trim());
    if (!match) continue;
    const index = Number(match[1]) - 1;
    const parts = splitTopicPath(match[2].replace(/[`*]/gu, '')).map((part) =>
      part.replace(/:/gu, ' ').replace(/\s+/gu, ' ').trim(),
    );
    if (index >= 0 && index < sectionCount && !labels[index] && parts.some(Boolean)) {
      labels[index] = parts.filter(Boolean);
    }
  }
  const missing = labels.flatMap((label, index) => (label ? [] : [index + 1]));
  if (missing.length > 0) {
    throw new TopicParseError(`Topic labels missing for sections ${missing.join(', ')}`, {
      missing,
      labels,
    });
  }
  return labels;
}

/**
 * Label fixed ranges and return parser-shaped groups. Ranges given the same
 * path merge into one topic, as a returning subject does in the LLM splitter.
 *
 * @param {object} input
 * @param {object} input.runtime Pipeline runtime.
 * @param {Array<{start: number, end: number}>} input.ranges Zero-based inclusive ranges.
 * @param {string[]} input.sentenceTexts Source sentences.
 * @param {Function} input.callLLMWithRetry Completion provider call.
 * @param {Function} [input.parallelMap] Concurrency helper.
 * @returns {Promise<object[]>} Groups with labels and zero-based ranges.
 */
export async function labelTopicRanges({
  runtime,
  ranges,
  sentenceTexts,
  callLLMWithRetry,
  parallelMap = defaultParallelMap,
}) {
  if (ranges.length === 0) return [];
  const batches = batchRangesForLabels(ranges, sentenceTexts, runtime.maxTextChunkChars);
  await runtime.log(
    'topic_labels_start',
    { rangeCount: ranges.length, batchCount: batches.length },
    { verbose: true },
  );
  const labelled = await parallelMap(batches, TOPIC_RANGE_CONCURRENCY, async (batch, index) => {
    const labels = new Array(batch.ranges.length).fill(null);
    // Positions still unlabelled; a retry re-asks only these, renumbered from 1.
    let pending = batch.ranges.map((_, position) => position);
    for (let attempt = 1; ; attempt++) {
      throwIfCancelled(runtime, TOPIC_RANGE_ABORT_MESSAGE);
      const prompt = buildTopicLabelsPrompt(
        numberSections(pending.map((position) => batch.bodies[position])),
        { preferContentLanguage: runtime.preferContentLanguage },
      );
      let response;
      await runtime.log(
        'topic_labels_llm_request',
        {
          batchIndex: index,
          sectionCount: pending.length,
          promptLength: prompt.length,
          attempt,
        },
        { verbose: true },
      );
      try {
        response = await callLLMWithRetry(
          { prompt, signal: runtime.signal, taskType: LLM_TASK_TYPES.TOPIC_LABELS },
          LABEL_PROVIDER_MAX_ATTEMPTS,
        );
        await runtime.log(
          'topic_labels_llm_response',
          { batchIndex: index, responseLength: response.length, attempt },
          { verbose: true },
        );
        const parsed = parseTopicLabels(response, pending.length);
        pending.forEach((position, local) => (labels[position] = parsed[local]));
        return labels;
      } catch (error) {
        rethrowIfCancelled(error, runtime, TOPIC_RANGE_ABORT_MESSAGE);
        if (!(error instanceof TopicParseError) || attempt > TOPIC_RANGE_STAGE_MAX_RETRIES) {
          await runtime.log('topic_labels_llm_error', {
            batchIndex: index,
            attempt,
            error: (error && error.message) || String(error),
          });
          throw error;
        }
        const partial = error.diagnostics?.labels ?? [];
        pending.forEach((position, local) => (labels[position] = partial[local] ?? null));
        pending = pending.filter((position) => !labels[position]);
        await runtime.log('topic_labels_parse_retry', {
          batchIndex: index,
          attempt,
          error: error.message,
          response: String(response).slice(0, 500),
        });
      }
    }
  });
  const segments = batches.flatMap((batch, index) =>
    batch.ranges.map((range, position) => ({ label: labelled[index][position], ...range })),
  );
  const groups = groupsFromSegments(segments, sentenceTexts.length);
  await runtime.log(
    'topic_labels_done',
    { rangeCount: ranges.length, batchCount: batches.length, groupCount: groups.length },
    { verbose: true },
  );
  return groups;
}
