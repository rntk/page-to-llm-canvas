import {
  buildArticleSummaryPrompt,
  buildArticleSummaryMergePrompt,
  buildLeafSummaryMergePrompt,
  buildTopicSummaryFromSourcePrompt,
  formatChunkSummaryForMerge,
  formatChunkSummariesForMerge,
} from './prompts.js';
import { parallelMap } from '../llm/llm.js';
import { LLM_TASK_TYPES } from '../metrics/llm.js';
import { runProviderBurst } from './providerBurst.js';
import { splitContiguousRuns } from './topicTreeMerge.js';
import {
  SOURCE_SUMMARY_MAX_CHARS,
  SUMMARY_CONCURRENCY,
  SUMMARY_MAX_MERGE_ROUNDS,
  SUMMARY_PROVIDER_MAX_ATTEMPTS,
} from './pipelineConfig.js';

const INLINE_SUMMARY_MAX_SENTENCES = 3;
const INLINE_SUMMARY_MAX_WORDS = 35;
const INLINE_SUMMARY_MAX_CHARS = 280;

const SUMMARY_PROFILES = {
  topic: {
    buildPrompt: buildTopicSummaryFromSourcePrompt,
    buildMergePrompt: buildArticleSummaryMergePrompt,
    taskType: LLM_TASK_TYPES.TOPIC_SUMMARY_FROM_SOURCE,
    parse: parseSummaryResult,
    fallback: (parsed, source) => parsed.text || source,
  },
  leaf: {
    buildPrompt: buildArticleSummaryPrompt,
    buildMergePrompt: buildLeafSummaryMergePrompt,
    taskType: LLM_TASK_TYPES.ARTICLE_SUMMARY,
    parse: parseSummaryResult,
    fallback: (parsed, source) => parsed.text || (parsed.noSummary ? source : ''),
  },
};

export function parseSummaryResponse(raw) {
  return parseSummaryResult(raw).text;
}

export function parseSummaryResult(raw) {
  if (!raw) return { text: '', noSummary: false };
  let summary = String(raw).trim();
  summary = summary
    .replace(/^```[a-z0-9_-]*\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  if (/^NO_SUMMARY\.?$/i.test(summary)) return { text: '', noSummary: true };
  return { text: summary, noSummary: false };
}

function wordCount(text) {
  return (String(text || '').match(/\S+/g) || []).length;
}

export function runSourceText(runIds, sentenceTexts) {
  return runIds
    .map((oneIdx) => sentenceTexts[oneIdx - 1])
    .filter(Boolean)
    .join(' ')
    .trim();
}

/** A short contiguous run can be shown verbatim without an LLM call.
 * @param {number[]} runSentences Sentence ids in the run.
 * @param {string} sourceText Source text for the run.
 */
export function shouldInlineRun(runSentences, sourceText) {
  const text = String(sourceText || '').trim();
  if (!text) return true;
  const sentenceCount = Array.isArray(runSentences) ? runSentences.length : 0;
  return (
    sentenceCount <= INLINE_SUMMARY_MAX_SENTENCES &&
    wordCount(text) <= INLINE_SUMMARY_MAX_WORDS &&
    text.length <= INLINE_SUMMARY_MAX_CHARS
  );
}

/**
 * Splits source sentences into char-bounded chunks at sentence boundaries.
 * Each chunk retains its global 1-based sentence range for merge labels.
 * @param {number[]} sourceSentenceIds Source sentence ids.
 * @param {string[]} sentenceTexts Article sentence text by id.
 * @param {number} maxChars Maximum chunk size.
 */
export function chunkSourceSentences(sourceSentenceIds, sentenceTexts, maxChars) {
  const chunks = [];
  let currentIds = [];
  let currentTexts = [];
  let currentLength = 0;
  const flush = () => {
    if (!currentIds.length) return;
    chunks.push({
      start: currentIds[0],
      end: currentIds[currentIds.length - 1],
      text: currentTexts.join(' '),
    });
    currentIds = [];
    currentTexts = [];
    currentLength = 0;
  };

  if (!Number.isFinite(maxChars) || maxChars <= 0) {
    throw new Error('maxChars must be positive');
  }

  for (const id of sourceSentenceIds) {
    const text = sentenceTexts[id - 1];
    if (!text) continue;
    if (text.length > maxChars) {
      flush();
      const parts = splitTextToMaxChars(text, maxChars);
      parts.forEach((partText, part) => {
        chunks.push({ start: id, end: id, text: partText, part });
      });
      continue;
    }
    let separatorLength = currentTexts.length > 0 ? 1 : 0;
    const addedLength = text.length + separatorLength;
    if (currentLength + addedLength > maxChars && currentIds.length) flush();
    separatorLength = currentTexts.length > 0 ? 1 : 0;
    currentIds.push(id);
    currentTexts.push(text);
    currentLength += text.length + separatorLength;
  }
  flush();
  return chunks;
}

function splitTextToMaxChars(text, maxChars) {
  const parts = [];
  let remaining = String(text || '');
  while (remaining.length > maxChars) {
    let splitAt = remaining.lastIndexOf(' ', maxChars);
    if (splitAt < Math.floor(maxChars / 2)) splitAt = maxChars;
    const part = remaining.slice(0, splitAt).trim();
    if (part) parts.push(part);
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) parts.push(remaining);
  return parts;
}

function chunkSummaryRecordsForMerge(records, maxChars) {
  const expanded = [];
  for (const record of records) {
    const oneRecordSource = formatChunkSummariesForMerge([record]);
    if (oneRecordSource.length <= maxChars) {
      expanded.push(record);
      continue;
    }
    const emptyRecordLength = formatChunkSummariesForMerge([
      { ...record, summary: { text: '' } },
    ]).length;
    const partMaxChars = Math.max(1, maxChars - emptyRecordLength);
    for (const part of splitTextToMaxChars(record.summary?.text || '', partMaxChars)) {
      expanded.push({ ...record, summary: { text: part } });
    }
  }

  const batches = [];
  let current = [];
  let currentLength = 0;
  for (const record of expanded) {
    const formatted = formatChunkSummaryForMerge(record, current.length);
    const separatorLength = current.length > 0 ? 2 : 0;
    if (current.length && currentLength + separatorLength + formatted.length > maxChars) {
      batches.push(current);
      current = [record];
      currentLength = formatChunkSummaryForMerge(record, 0).length;
    } else {
      current.push(record);
      currentLength += separatorLength + formatted.length;
    }
  }
  if (current.length) batches.push(current);
  return batches;
}

function mergeRecordsEqual(left, right) {
  return (
    left.length === right.length &&
    left.every(
      (record, index) =>
        record.start_sentence === right[index].start_sentence &&
        record.end_sentence === right[index].end_sentence &&
        record.summary?.text === right[index].summary?.text,
    )
  );
}

/**
 * Builds the source summarizer injected into topic-tree resolution. Internal
 * nodes summarize fresh source rather than repeatedly merging already-brief
 * child summaries. Oversized runs are summarized by chunk and merged in
 * bounded rounds, so neither source nor intermediate merge requests can exceed
 * the configured context budget.
 * @param {object} input Source text and LLM dependencies.
 */
export function makeSourceSummarizer({
  sentenceTexts,
  limit,
  signal,
  preferContentLanguage = false,
  callLLMWithRetry,
  summaryMode = 'topic',
  maxChars = SOURCE_SUMMARY_MAX_CHARS,
}) {
  const profile = SUMMARY_PROFILES[summaryMode];
  if (!profile) throw new Error(`Unknown source summary mode: ${summaryMode}`);
  const requestMaxChars =
    Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : SOURCE_SUMMARY_MAX_CHARS;

  const summarizeText = async (text, sourceSummaryUnit) => {
    const response = await limit(() =>
      callLLMWithRetry(
        {
          prompt: profile.buildPrompt(text, { preferContentLanguage }),
          temperature: 0.8,
          signal,
          taskType: profile.taskType,
          sourceSummaryUnit: { ...sourceSummaryUnit, profile: summaryMode },
        },
        SUMMARY_PROVIDER_MAX_ATTEMPTS,
      ),
    );
    return profile.fallback(profile.parse(response), text);
  };

  const summarizeRun = async (runIds, text, path) => {
    if (text.length <= requestMaxChars) {
      return await summarizeText(text, {
        kind: 'single',
        source: text,
        path,
        runSentences: runIds,
        startSentence: runIds[0],
        endSentence: runIds[runIds.length - 1],
      });
    }

    const chunks = chunkSourceSentences(runIds, sentenceTexts, requestMaxChars);
    const {
      results: chunkResults,
      permanentError,
      unclaimed,
    } = await runProviderBurst(chunks, SUMMARY_CONCURRENCY, async ({ item: chunk }) => {
      try {
        const summaryText = await summarizeText(chunk.text, {
          kind: 'chunk',
          source: chunk.text,
          path,
          runSentences: runIds,
          startSentence: chunk.start,
          endSentence: chunk.end,
          ...(Number.isInteger(chunk.part) ? { part: chunk.part } : {}),
        });
        return { chunk, text: summaryText };
      } catch (error) {
        // Catch per item so parallelMap waits for all in-flight siblings before
        // surfacing the first failure.
        return { chunk, error };
      }
    });
    const failedChunk = chunkResults.find((result) => result?.error);
    if (failedChunk) throw failedChunk.error;
    if (unclaimed.length > 0) {
      throw permanentError || new Error('Provider burst abandoned chunks without an error');
    }

    let records = chunkResults.map(({ chunk, text: summaryText }) => ({
      start_sentence: chunk.start,
      end_sentence: chunk.end,
      summary: { text: summaryText },
    }));
    for (let round = 0; round < SUMMARY_MAX_MERGE_ROUNDS && records.length > 1; round++) {
      const batches = chunkSummaryRecordsForMerge(records, requestMaxChars);
      const mergedBatches = await parallelMap(
        batches,
        SUMMARY_CONCURRENCY,
        async (batch, batchIndex) => {
          const mergeSource = formatChunkSummariesForMerge(batch);
          const mergeResponse = await limit(() =>
            callLLMWithRetry(
              {
                prompt: profile.buildMergePrompt(mergeSource, { preferContentLanguage }),
                temperature: 0.8,
                signal,
                taskType: LLM_TASK_TYPES.ARTICLE_SUMMARY_MERGE,
                sourceSummaryUnit: {
                  kind: 'merge',
                  source: mergeSource,
                  path,
                  runSentences: runIds,
                  startSentence: batch[0].start_sentence,
                  endSentence: batch[batch.length - 1].end_sentence,
                  ...(round > 0 || batches.length > 1 ? { part: `${round}:${batchIndex}` } : {}),
                },
              },
              SUMMARY_PROVIDER_MAX_ATTEMPTS,
            ),
          );
          const parsed = profile.parse(mergeResponse);
          return {
            start_sentence: batch[0].start_sentence,
            end_sentence: batch[batch.length - 1].end_sentence,
            summary: {
              text:
                parsed.text ||
                batch
                  .map((record) => record.summary.text)
                  .filter(Boolean)
                  .join('\n'),
            },
          };
        },
        { warmupFirst: true },
      );
      const madeProgress = !mergeRecordsEqual(records, mergedBatches);
      records = mergedBatches;
      // Empty/NO_SUMMARY singleton responses reproduce the same records. Do
      // not pay for identical work in every remaining bounded round.
      if (!madeProgress) break;
    }
    // If the round cap leaves multiple records, keep the newest successful
    // merges instead of reverting to the pre-merge chunk summaries.
    return records
      .map((record) => record.summary.text)
      .filter(Boolean)
      .join('\n');
  };

  return async (sourceSentenceIds, info = {}) => {
    const ids = Array.isArray(sourceSentenceIds)
      ? sourceSentenceIds.filter(
          (id) => Number.isInteger(id) && id > 0 && id <= sentenceTexts.length,
        )
      : [];
    const runs = splitContiguousRuns(ids);
    const {
      results: summarized,
      permanentError: permanentRunError,
      unclaimed,
    } = await runProviderBurst(runs, SUMMARY_CONCURRENCY, async ({ item: runIds }) => {
      try {
        const text = runSourceText(runIds, sentenceTexts);
        if (!text) return { sentences: runIds, text: '' };
        if (shouldInlineRun(runIds, text)) return { sentences: runIds, text };
        return {
          sentences: runIds,
          text: await summarizeRun(runIds, text, typeof info?.path === 'string' ? info.path : ''),
        };
      } catch (error) {
        return { sentences: runIds, error };
      }
    });
    const failedRun = summarized.find((result) => result?.error);
    if (failedRun) throw failedRun.error;
    if (unclaimed.length > 0) {
      throw permanentRunError || new Error('Provider burst abandoned runs without an error');
    }
    return { runs: summarized };
  };
}
