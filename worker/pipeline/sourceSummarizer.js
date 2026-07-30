import {
  buildArticleSummaryMergePrompt,
  buildTopicSummaryFromSourcePrompt,
  formatChunkSummariesForMerge,
} from './prompts.js';
import { parallelMap } from '../llm/llm.js';
import { LLM_TASK_TYPES } from '../metrics/llm.js';
import { splitContiguousRuns } from './topicTreeMerge.js';
import { SOURCE_SUMMARY_MAX_CHARS, SUMMARY_CONCURRENCY } from './pipelineConfig.js';

const INLINE_SUMMARY_MAX_SENTENCES = 3;
const INLINE_SUMMARY_MAX_WORDS = 35;
const INLINE_SUMMARY_MAX_CHARS = 280;

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

/** A short contiguous run can be shown verbatim without an LLM call. */
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
 */
export function chunkSourceSentences(sourceSentenceIds, sentenceTexts, maxChars) {
  const chunks = [];
  let current = [];
  let currentLength = 0;
  const flush = () => {
    if (!current.length) return;
    chunks.push({
      start: current[0],
      end: current[current.length - 1],
      text: current
        .map((id) => sentenceTexts[id - 1])
        .filter(Boolean)
        .join(' '),
    });
    current = [];
    currentLength = 0;
  };

  for (const id of sourceSentenceIds) {
    const text = sentenceTexts[id - 1];
    if (!text) continue;
    const addedLength = text.length + 1;
    if (currentLength + addedLength > maxChars && current.length) flush();
    current.push(id);
    currentLength += addedLength;
  }
  flush();
  return chunks;
}

/**
 * Builds the source summarizer injected into topic-tree resolution. Internal
 * nodes summarize fresh source rather than repeatedly merging already-brief
 * child summaries. Oversized runs are summarized by chunk and merged once.
 */
export function makeSourceSummarizer({
  sentenceTexts,
  limit,
  signal,
  preferContentLanguage = false,
  callLLMWithRetry,
}) {
  const summarizeText = async (text) => {
    const response = await limit(() =>
      callLLMWithRetry({
        prompt: buildTopicSummaryFromSourcePrompt(text, { preferContentLanguage }),
        temperature: 0.8,
        signal,
        taskType: LLM_TASK_TYPES.TOPIC_SUMMARY_FROM_SOURCE,
      }),
    );
    return parseSummaryResponse(response) || text;
  };

  const summarizeRun = async (runIds, text) => {
    if (text.length <= SOURCE_SUMMARY_MAX_CHARS) {
      return await summarizeText(text);
    }

    const chunks = chunkSourceSentences(runIds, sentenceTexts, SOURCE_SUMMARY_MAX_CHARS);
    const records = await parallelMap(chunks, SUMMARY_CONCURRENCY, async (chunk) => ({
      start_sentence: chunk.start,
      end_sentence: chunk.end,
      summary: { text: await summarizeText(chunk.text) },
    }));
    const mergeResponse = await limit(() =>
      callLLMWithRetry({
        prompt: buildArticleSummaryMergePrompt(formatChunkSummariesForMerge(records), {
          preferContentLanguage,
        }),
        temperature: 0.8,
        signal,
        taskType: LLM_TASK_TYPES.ARTICLE_SUMMARY_MERGE,
      }),
    );
    const merged = parseSummaryResponse(mergeResponse);
    if (merged) return merged;
    return records
      .map((record) => record.summary.text)
      .filter(Boolean)
      .join('\n');
  };

  return async (sourceSentenceIds) => {
    const ids = Array.isArray(sourceSentenceIds)
      ? sourceSentenceIds.filter(
          (id) => Number.isInteger(id) && id > 0 && id <= sentenceTexts.length,
        )
      : [];
    const runs = splitContiguousRuns(ids);
    const summarized = await parallelMap(runs, SUMMARY_CONCURRENCY, async (runIds) => {
      const text = runSourceText(runIds, sentenceTexts);
      if (!text) return { sentences: runIds, text: '' };
      if (shouldInlineRun(runIds, text)) return { sentences: runIds, text };
      return { sentences: runIds, text: await summarizeRun(runIds, text) };
    });
    return { runs: summarized };
  };
}
