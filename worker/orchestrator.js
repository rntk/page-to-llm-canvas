// Pipeline entry point: clean HTML, split sentences, LLM topic ranges, per-topic summaries.
// NOTE: This module runs in the service worker context (background.js), not
// inside the modal iframe. It is kept in the worker/ directory for historical
// reasons, but it is no longer bundled into the modal UI.

import { appendProcessingLog, readRecord, updateRecord } from './storage.js';
import { stripTagsKeepOffsets } from './html.js';
import { splitSentences } from './sentence_splitter.js';
import {
  buildTaggedText,
  buildTopicRangesPrompt,
  buildArticleSummaryPrompt,
  buildArticleSummaryMergePrompt,
  buildTopicSummaryFromSourcePrompt,
  formatChunkSummariesForMerge,
} from './prompts.js';
import { parseTopicRanges, groupsFromSegments, TopicParseError } from './topic_parser.js';
import { callLLMWithRetry, createLimiter, parallelMap } from './llm.js';
import { queryTopicRangesWithRetry } from './topicRangeRetry.js';
import { planSummaryWork } from './summaryPlanning.js';
import { summarizeTopicTree } from './topicTreeMerge.js';
import { getStoredPreferContentLanguage } from './languageSettings.js';

const MAX_TAGGED_CHARS = 60000;
// Budget for an internal topic node's own source text before we summarize it in
// one call vs. split it into chunks and merge. Mirrors MAX_TAGGED_CHARS but
// applies to raw source text (no {N} markers), so it is named separately.
const SOURCE_SUMMARY_MAX_CHARS = MAX_TAGGED_CHARS;
const SUMMARY_CONCURRENCY = 4;
const TOPIC_RANGE_CONCURRENCY = 4;
const INLINE_SUMMARY_MAX_SENTENCES = 3;
const INLINE_SUMMARY_MAX_WORDS = 35;
const INLINE_SUMMARY_MAX_CHARS = 280;
// The topic-ranges and resplit calls demand a strict line format; a low
// temperature cuts malformed output (and the expensive parse-retry loop it
// triggers). Summaries and merges are prose and keep their own temperature.
const TOPIC_RANGE_TEMPERATURE = 0.2;
const TOPIC_RANGE_MAX_RETRIES = 3;
const TOPIC_RANGE_RETRY_BASE_DELAY_MS = 2000;
// A single topic range covering more than this many sentences is considered
// "too big" — the LLM lumped distinct subjects together. We re-query the LLM on
// just that slice to subdivide it, mirroring the gap-recovery idea (re-ask the
// LLM about a problematic region). TOPIC_RANGE_RESPLIT_MAX_DEPTH bounds how many
// nested re-split passes a single oversized range may trigger.
const TOPIC_RANGE_MAX_SENTENCES = 40;
const TOPIC_RANGE_RESPLIT_MAX_DEPTH = 2;

/**
 * @param {{key: string, pipelineRunId?: string, signal?: AbortSignal}} context
 * @param {string} stage
 * @param {Record<string, unknown>} [details]
 * @returns {Promise<void>}
 */
async function logPipeline(context, stage, details = {}) {
  console.info('PageToLLM Canvas pipeline:', stage, details);
  assertPipelineActive(context);
  await appendProcessingLog(context.key, stage, details, {
    expectedPipelineRunId: context.pipelineRunId,
  }).catch((err) => {
    console.warn('PageToLLM Canvas pipeline log failed:', err);
  });
}

function assertPipelineActive(context) {
  if (context?.signal?.aborted) {
    const err = new Error('Pipeline run was cancelled');
    err.name = 'AbortError';
    throw err;
  }
}

async function updatePipelineRecord(context, patch) {
  assertPipelineActive(context);
  const updated = await updateRecord(context.key, patch, {
    expectedPipelineRunId: context.pipelineRunId,
  });
  if (!updated) {
    const err = new Error('Pipeline run is no longer current');
    err.name = 'AbortError';
    throw err;
  }
  return updated;
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
 * Maps a raw LLM/transport error to a stable `kind` plus a short, user-facing
 * message. The `kind` drives any UI grouping; `message` is what the confirm
 * popup and the processing log show the user. The raw error is preserved
 * separately so the technical detail is never lost.
 *
 * @param {unknown} e
 * @returns {{ kind: string, message: string }}
 */
export function classifyLlmError(e) {
  const raw = (e && e.message) || String(e);
  if (/timed out|timeout/i.test(raw)) {
    return { kind: 'timeout', message: 'The model did not respond in time.' };
  }
  if (/\b429\b|rate.?limit/i.test(raw)) {
    return { kind: 'rate_limited', message: 'The model provider is rate limiting requests.' };
  }
  if (/no llm provider|provider configured|no model configured/i.test(raw)) {
    return { kind: 'no_provider', message: 'No model is configured. Add one in the options page.' };
  }
  if (/\b401\b|\b403\b|unauthor|forbidden|api key/i.test(raw)) {
    return {
      kind: 'auth',
      message: 'The model provider rejected the request (check your API key).',
    };
  }
  // Unclassified: surface the raw error but cap it — provider clients can embed a
  // few hundred chars of response body, which we don't want dumped into the popup.
  const message = raw.length > 200 ? `${raw.slice(0, 200)}…` : raw;
  return { kind: 'error', message };
}

export function parseSummaryResponse(raw) {
  return parseSummaryResult(raw).text;
}

function parseSummaryResult(raw) {
  if (!raw) return { text: '', noSummary: false };
  let s = String(raw).trim();

  s = s
    .replace(/^```[a-z0-9_-]*\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  if (/^NO_SUMMARY\.?$/i.test(s)) return { text: '', noSummary: true };
  return { text: s, noSummary: false };
}

function wordCount(text) {
  return (String(text || '').match(/\S+/g) || []).length;
}

function topicSourceText(topic, sentenceTexts) {
  const sentenceIds = Array.isArray(topic.sentences) ? topic.sentences : [];
  return sentenceIds
    .map((oneIdx) => sentenceTexts[oneIdx - 1])
    .filter(Boolean)
    .join(' ')
    .trim();
}

export function shouldInlineTopicSummary(topic, sourceText) {
  const text = String(sourceText || '').trim();
  if (!text) return true;
  const sentenceCount = Array.isArray(topic.sentences) ? topic.sentences.length : 0;
  return (
    sentenceCount <= INLINE_SUMMARY_MAX_SENTENCES &&
    wordCount(text) <= INLINE_SUMMARY_MAX_WORDS &&
    text.length <= INLINE_SUMMARY_MAX_CHARS
  );
}

export function buildTopicTree(topics) {
  const root = {
    path: '',
    name: '',
    level: 0,
    children: [],
    leafSummary: null,
    sourceSentences: [],
  };
  const nodes = new Map([['', root]]);

  function getOrCreate(path) {
    if (nodes.has(path)) return nodes.get(path);
    const parts = path.split('>');
    const parentPath = parts.slice(0, -1).join('>');
    const parent = getOrCreate(parentPath);
    const node = {
      path,
      name: parts[parts.length - 1],
      level: parts.length,
      children: [],
      leafSummary: null,
      sourceSentences: [],
    };
    parent.children.push(node);
    nodes.set(path, node);
    return node;
  }

  for (const topic of topics) {
    if (!topic.name || topic.name === 'no_topic') continue;
    const node = getOrCreate(topic.name);
    node.sourceSentences = Array.isArray(topic.sentences) ? [...topic.sentences] : [];
  }

  function aggregate(node) {
    const agg = new Set(node.sourceSentences);
    for (const child of node.children) {
      for (const s of aggregate(child)) agg.add(s);
    }
    node.sourceSentences = Array.from(agg).sort((a, b) => a - b);
    return node.sourceSentences;
  }
  aggregate(root);

  return { root, nodes };
}

/**
 * Splits a node's source sentences into char-bounded chunks at sentence
 * boundaries (so the overflow path never cuts a sentence mid-way). Each chunk
 * carries its global 1-based sentence range for the merge prompt's labels.
 *
 * @param {number[]} sourceSentenceIds  sorted 1-based sentence indices
 * @param {string[]} sentenceTexts
 * @param {number} maxChars
 * @returns {Array<{start: number, end: number, text: string}>}
 */
export function chunkSourceSentences(sourceSentenceIds, sentenceTexts, maxChars) {
  const chunks = [];
  let cur = [];
  let curLen = 0;
  const flush = () => {
    if (!cur.length) return;
    chunks.push({
      start: cur[0],
      end: cur[cur.length - 1],
      text: cur
        .map((id) => sentenceTexts[id - 1])
        .filter(Boolean)
        .join(' '),
    });
    cur = [];
    curLen = 0;
  };
  for (const id of sourceSentenceIds) {
    const text = sentenceTexts[id - 1];
    if (!text) continue;
    const addLen = text.length + 1;
    if (curLen + addLen > maxChars && cur.length) flush();
    cur.push(id);
    curLen += addLen;
  }
  flush();
  return chunks;
}

/**
 * Builds the `summarizeSource` function the topic-tree builder injects for every
 * internal node. It generates a FRESH summary from the node's own source
 * sentences instead of merging the children's already-brief summaries (a
 * summary-of-summaries loses facts level by level). When the source fits
 * SOURCE_SUMMARY_MAX_CHARS it is summarized in one call; otherwise it is split
 * into char-bounded chunks, each chunk is summarized from source, and those
 * chunk summaries are merged. Every LLM call goes through `limit` so concurrent
 * node summaries stay within the provider's rate budget (a 429 degrades a
 * summary to empty).
 *
 * @param {string[]} sentenceTexts
 * @param {<T>(fn: () => Promise<T>) => Promise<T>} limit
 * @param {AbortSignal|undefined} signal
 * @returns {(sourceSentenceIds: number[]) => Promise<{text: string}>}
 */
function makeSourceSummarizer(sentenceTexts, limit, signal, preferContentLanguage = false) {
  const summarizeText = async (text) => {
    const resp = await limit(() =>
      callLLMWithRetry({
        prompt: buildTopicSummaryFromSourcePrompt(text, { preferContentLanguage }),
        temperature: 0.8,
        signal,
      }),
    );
    // The source prompt offers no NO_SUMMARY escape, so an empty/NO_SUMMARY reply
    // is a stray model output rather than a real "nothing to summarize". Mirror
    // the leaf path's NO_SUMMARY→source fallback and return the source text so an
    // internal topic (or any of its chunks) is never silently empty. `text` is
    // bounded by SOURCE_SUMMARY_MAX_CHARS at both call sites.
    return parseSummaryResponse(resp) || text;
  };
  return async (sourceSentenceIds) => {
    const ids = Array.isArray(sourceSentenceIds) ? sourceSentenceIds : [];
    const joined = ids
      .map((id) => sentenceTexts[id - 1])
      .filter(Boolean)
      .join(' ')
      .trim();
    if (!joined) return { text: '' };
    if (joined.length <= SOURCE_SUMMARY_MAX_CHARS) {
      return { text: await summarizeText(joined) };
    }
    const chunks = chunkSourceSentences(ids, sentenceTexts, SOURCE_SUMMARY_MAX_CHARS);
    const records = await parallelMap(chunks, SUMMARY_CONCURRENCY, async (chunk) => ({
      start_sentence: chunk.start,
      end_sentence: chunk.end,
      summary: { text: await summarizeText(chunk.text) },
    }));
    const mergeResp = await limit(() =>
      callLLMWithRetry({
        prompt: buildArticleSummaryMergePrompt(formatChunkSummariesForMerge(records), {
          preferContentLanguage,
        }),
        temperature: 0.8,
        signal,
      }),
    );
    const merged = parseSummaryResponse(mergeResp);
    if (merged) return { text: merged };
    // The merge collapsed to empty (e.g. a stray NO_SUMMARY) even though the
    // chunk summaries succeeded. Internal nodes have no NO_SUMMARY escape, so
    // rather than silently shipping an empty parent topic we fall back to the
    // chunk summaries themselves — losing the cross-chunk dedupe but keeping the
    // facts. (Empty only if every chunk was itself empty, i.e. genuinely no
    // content.)
    const fallback = records
      .map((r) => r.summary.text)
      .filter(Boolean)
      .join('\n');
    return { text: fallback };
  };
}

export function rangesToSentenceList(ranges) {
  // ranges are 0-based inclusive; output 1-based ordered unique list.
  const set = new Set();
  for (const r of ranges) {
    for (let i = r.start; i <= r.end; i++) set.add(i);
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
  return groups.map((g) => {
    const name = g.label.join('>');
    const oneBased = rangesToSentenceList(g.ranges);
    const sentence_spans = oneBased.map((oneIdx) => {
      const idx = oneIdx - 1;
      const so = sentenceObjs[idx];
      return {
        sentence: oneIdx,
        start: mapTextOffsetToHtml(mapping, so.start),
        end: mapTextOffsetToHtml(mapping, so.end),
      };
    });
    const ranges = g.ranges.map((r) => {
      const sIdx = r.start;
      const eIdx = r.end;
      return {
        sentence_start: sIdx + 1,
        sentence_end: eIdx + 1,
        start: mapTextOffsetToHtml(mapping, sentenceObjs[sIdx].start),
        end: mapTextOffsetToHtml(mapping, sentenceObjs[eIdx].end),
      };
    });
    return { name, sentences: oneBased, sentence_spans, ranges };
  });
}

/**
 * Re-query the LLM to subdivide a single oversized sentence range. The slice is
 * re-tagged with local 0-based markers, partitioned by the same topic-ranges
 * prompt, then offset back to global sentence indices. Because parseTopicRanges
 * guarantees continuous coverage of [0, sliceLen-1], the returned segments cover
 * exactly [seg.start, seg.end] with no gaps or overlaps.
 *
 * Returns null when the re-split made no real progress (LLM/parse failure, or the
 * slice came back as a single topic) so the caller keeps the original range.
 *
 * @param {{key: string, pipelineRunId?: string, signal?: AbortSignal}} context
 * @param {{label: string[], start: number, end: number}} seg
 * @param {string[]} sentenceTexts
 * @param {number} depth
 * @returns {Promise<Array<{label: string[], start: number, end: number}> | null>}
 */
async function resplitSegment(context, seg, sentenceTexts, depth) {
  const span = seg.end - seg.start + 1;
  const sliceTexts = sentenceTexts.slice(seg.start, seg.end + 1);
  const tagged = buildTaggedText(sliceTexts);
  const chunks =
    tagged.length > MAX_TAGGED_CHARS ? chunkTaggedText(tagged, MAX_TAGGED_CHARS) : [tagged];

  await logPipeline(context, 'topic_ranges_resplit_request', {
    start: seg.start,
    end: seg.end,
    span,
    depth,
    chunkCount: chunks.length,
  });

  let subGroups;
  try {
    // Single attempt (no parse-retry): on any LLM or parse failure we log a
    // resplit error and fall back to the original range below.
    subGroups = await queryTopicRangesWithRetry({
      maxRetries: 0,
      callLLM: async () => {
        const responses = await parallelMap(chunks, TOPIC_RANGE_CONCURRENCY, (chunk) =>
          callLLMWithRetry({
            prompt: buildTopicRangesPrompt(chunk, {
              preferContentLanguage: context.preferContentLanguage,
            }),
            temperature: TOPIC_RANGE_TEMPERATURE,
            signal: context.signal,
          }),
        );
        return responses.join('\n');
      },
      parse: (raw) => parseTopicRanges(raw, sliceTexts.length),
    });
  } catch (e) {
    await logPipeline(context, 'topic_ranges_resplit_error', {
      start: seg.start,
      end: seg.end,
      depth,
      error: (e && e.message) || String(e),
    });
    return null;
  }

  // Offset local marker indices back to global sentence indices.
  const offset = seg.start;
  let subSegments = [];
  for (const g of subGroups) {
    for (const r of g.ranges) {
      subSegments.push({ label: g.label, start: r.start + offset, end: r.end + offset });
    }
  }
  subSegments.sort((a, b) => a.start - b.start);

  if (subSegments.length <= 1) {
    // The LLM still considers the slice one topic — keep the original range.
    await logPipeline(context, 'topic_ranges_resplit_no_progress', {
      start: seg.start,
      end: seg.end,
      span,
      depth,
    });
    return null;
  }

  await logPipeline(context, 'topic_ranges_resplit_response', {
    start: seg.start,
    end: seg.end,
    span,
    depth,
    subSegmentCount: subSegments.length,
  });

  // Recurse into any sub-segment that is still oversized, up to the depth bound.
  if (depth + 1 < TOPIC_RANGE_RESPLIT_MAX_DEPTH) {
    const expanded = await parallelMap(subSegments, TOPIC_RANGE_CONCURRENCY, async (s) => {
      if (s.end - s.start + 1 > TOPIC_RANGE_MAX_SENTENCES) {
        const deeper = await resplitSegment(context, s, sentenceTexts, depth + 1);
        if (deeper) return deeper;
      }
      return [s];
    });
    subSegments = expanded.flat();
  }

  return subSegments;
}

/**
 * Best-effort refinement of oversized topic ranges. Flattens groups into ordered
 * segments, re-splits any segment exceeding TOPIC_RANGE_MAX_SENTENCES via extra
 * LLM calls, then rebuilds groups (deduping labels to preserve unique topic
 * names). Returns the original groups unchanged on any failure or when nothing
 * needed refining.
 *
 * @param {{key: string, pipelineRunId?: string, signal?: AbortSignal}} context
 * @param {Array<{label: string[], ranges: Array<{start: number, end: number}>}>} groups
 * @param {string[]} sentenceTexts
 * @returns {Promise<Array<{label: string[], ranges: Array<{start: number, end: number}>}>>}
 */
async function refineOversizedRanges(context, groups, sentenceTexts) {
  const segments = [];
  for (const g of groups) {
    for (const r of g.ranges) {
      segments.push({ label: g.label, start: r.start, end: r.end });
    }
  }
  segments.sort((a, b) => a.start - b.start);

  const oversized = segments.filter((s) => s.end - s.start + 1 > TOPIC_RANGE_MAX_SENTENCES);
  if (!oversized.length) return groups;

  await logPipeline(context, 'topic_ranges_oversize_detected', {
    oversizeCount: oversized.length,
    maxSentences: TOPIC_RANGE_MAX_SENTENCES,
    spans: oversized.map((s) => s.end - s.start + 1),
  });

  let changed = false;
  // Re-split oversized segments concurrently; parallelMap keeps document order.
  const refinedParts = await parallelMap(segments, TOPIC_RANGE_CONCURRENCY, async (seg) => {
    if (seg.end - seg.start + 1 > TOPIC_RANGE_MAX_SENTENCES) {
      const subSegments = await resplitSegment(context, seg, sentenceTexts, 0);
      if (subSegments && subSegments.length > 1) {
        changed = true;
        return subSegments;
      }
    }
    return [seg];
  });
  const refined = refinedParts.flat();

  if (!changed) return groups;

  const regrouped = groupsFromSegments(refined, sentenceTexts.length);
  await logPipeline(context, 'topic_ranges_oversize_refined', {
    groupCountBefore: groups.length,
    groupCountAfter: regrouped.length,
  });
  return regrouped;
}

export async function runPipeline(key, options = {}) {
  const context = {
    key,
    pipelineRunId: options.pipelineRunId,
    signal: options.signal,
    // Read once per run so every prompt in this run uses a consistent setting,
    // even if the user toggles it mid-pipeline. Defaults to off on any failure.
    preferContentLanguage: await getStoredPreferContentLanguage(),
  };
  try {
    await logPipeline(context, 'pipeline_start');
    const rec = await readRecord(key);
    if (!rec) throw new Error(`record not found: ${key}`);

    // Resume path. A record left in 'summarizing' means topic ranges were
    // already computed for the *current* html (status is set to 'summarizing'
    // only after topics are persisted, and any re-submit/reprocess resets the
    // status to 'pending' first). On a service-worker recycle the keepalive
    // alarm re-invokes runPipeline; without this branch we would redo the
    // expensive clean/split/topic_ranges stages and re-summarize every topic.
    // Resuming reuses the stored topics and sentences and only fills in the
    // summaries that are still missing.
    const resuming =
      rec.status === 'summarizing' && Array.isArray(rec.topics) && rec.topics.length > 0;

    let topics;
    let sentenceTexts;
    if (resuming) {
      topics = rec.topics;
      sentenceTexts = Array.isArray(rec.sentences) ? rec.sentences : [];
      const existingSummaries =
        rec.topic_summaries && typeof rec.topic_summaries === 'object' ? rec.topic_summaries : {};
      await logPipeline(context, 'pipeline_resume', {
        stage: 'summarizing',
        topicCount: topics.length,
        existingSummaryCount: Object.keys(existingSummaries).length,
      });
      await updatePipelineRecord(context, { status: 'summarizing', error: null });
    } else {
      ({ topics, sentenceTexts } = await computeTopics(context, rec));
      if (!topics) return; // no sentences — pipeline already marked done.
    }

    // Reuse already-computed summaries only when resuming: those were produced
    // for the current html. On a fresh run (re-submit / retry) the stored
    // summaries may belong to different html, so we start clean.
    const previousSummaries =
      resuming && rec.topic_summaries && typeof rec.topic_summaries === 'object'
        ? rec.topic_summaries
        : {};
    // `forceFinalize` is set by the "skip" decision on a parked (needs_attention)
    // record: it tells runSummaries to finish to `done` accepting empty summaries
    // for the failed topics instead of parking again. Only honored on a resume.
    const forceFinalize = resuming && rec.forceFinalize === true;
    await runSummaries(context, topics, sentenceTexts, previousSummaries, forceFinalize);
  } catch (e) {
    if (e?.name === 'AbortError') {
      return;
    }
    await logPipeline(context, 'pipeline_error', {
      error: String(e && e.stack ? e.stack : e),
    });
    await updatePipelineRecord(context, {
      status: 'error',
      error: String(e && e.stack ? e.stack : e),
    }).catch((writeErr) => {
      console.error('PageToLLM Canvas: failed to persist error status to storage:', writeErr);
    });
    throw e;
  }
}

/**
 * Cleans the HTML, splits sentences, and runs the LLM topic-ranges stage.
 * Returns `{ topics, sentenceTexts }`, or `{ topics: null }` when the page had
 * no sentences (in which case the record is already marked done).
 *
 * @param {{key: string, pipelineRunId?: string, signal?: AbortSignal}} context
 * @param {object} rec
 * @returns {Promise<{topics: Array<object>|null, sentenceTexts: string[]}>}
 */
async function computeTopics(context, rec) {
  await updatePipelineRecord(context, {
    status: 'splitting',
    progress: { stage: 'cleaning_html', done: 0, total: 0 },
    error: null,
    topics: [],
    topic_summaries: {},
    topic_summary_index: {},
  });
  await logPipeline(context, 'cleaning_html_start', {
    htmlLength: String(rec.html || '').length,
  });

  const { text, mapping } = stripTagsKeepOffsets(rec.html || '');
  await logPipeline(context, 'cleaning_html_done', {
    textLength: text.length,
    mappingLength: mapping.length,
  });

  await updatePipelineRecord(context, {
    text,
    progress: { stage: 'splitting_sentences', done: 0, total: 0 },
  });
  await logPipeline(context, 'splitting_sentences_start');

  const sentenceObjs = splitSentences(text);
  const sentenceTexts = sentenceObjs.map((s) => s.text);
  await logPipeline(context, 'splitting_sentences_done', {
    sentenceCount: sentenceTexts.length,
  });

  await updatePipelineRecord(context, {
    sentences: sentenceTexts,
    progress: { stage: 'topic_ranges', done: 0, total: sentenceTexts.length },
  });

  if (sentenceTexts.length === 0) {
    await updatePipelineRecord(context, {
      status: 'done',
      topics: [],
      topic_summaries: {},
      progress: { stage: 'done', done: 0, total: 0 },
    });
    return { topics: null, sentenceTexts };
  }

  const tagged = buildTaggedText(sentenceTexts);
  const chunks =
    tagged.length > MAX_TAGGED_CHARS ? chunkTaggedText(tagged, MAX_TAGGED_CHARS) : [tagged];
  await logPipeline(context, 'topic_ranges_start', {
    taggedLength: tagged.length,
    chunkCount: chunks.length,
  });

  let groups = await queryTopicRangesWithRetry({
    maxRetries: TOPIC_RANGE_MAX_RETRIES,
    baseDelayMs: TOPIC_RANGE_RETRY_BASE_DELAY_MS,
    isRetryable: (e) => e instanceof TopicParseError,
    callLLM: async (attemptIndex) => {
      // Chunks are independent (markers are global, assigned before chunking),
      // so query them concurrently; parallelMap preserves response order.
      const responses = await parallelMap(
        chunks,
        TOPIC_RANGE_CONCURRENCY,
        async (chunk, chunkIndex) => {
          const prompt = buildTopicRangesPrompt(chunk, {
            preferContentLanguage: context.preferContentLanguage,
          });
          await logPipeline(context, 'topic_ranges_llm_request', {
            chunkIndex,
            promptLength: prompt.length,
            attempt: attemptIndex + 1,
          });
          const resp = await callLLMWithRetry({
            prompt,
            temperature: TOPIC_RANGE_TEMPERATURE,
            signal: context.signal,
          });
          await logPipeline(context, 'topic_ranges_llm_response', {
            chunkIndex,
            responseLength: resp.length,
            attempt: attemptIndex + 1,
          });
          return resp;
        },
      );
      return responses.join('\n');
    },
    parse: (combined) => parseTopicRanges(combined, sentenceTexts.length),
    onParseRetry: ({ attemptNumber, maxRetries, error }) =>
      logPipeline(context, 'topic_ranges_parse_retry', {
        attempt: attemptNumber,
        maxRetries,
        error: error.message,
      }),
  });

  try {
    groups = await refineOversizedRanges(context, groups, sentenceTexts);
  } catch (e) {
    // Refinement is best-effort; never fail the pipeline over an oversized range.
    await logPipeline(context, 'topic_ranges_oversize_error', {
      error: (e && e.message) || String(e),
    });
  }

  await logPipeline(context, 'topic_ranges_done', {
    groupCount: groups.length,
  });

  const topics = groupsToTopics(groups, sentenceObjs, mapping);

  await updatePipelineRecord(context, {
    topics,
    status: 'summarizing',
    progress: { stage: 'summarizing_topics', done: 0, total: topics.length },
  });

  return { topics, sentenceTexts };
}

/**
 * Flattens the leaf summary map into the `summaryErrors` shape used by the
 * confirm popup: one entry per leaf still flagged `error: true`.
 *
 * @param {Record<string, {error?: boolean, error_kind?: string, error_message?: string, error_detail?: string}>} topicSummaries
 * @returns {Array<{topic: string, error_kind: string, error_message: string, error_detail?: string}>}
 */
function collectSummaryErrors(topicSummaries) {
  const out = [];
  for (const [topic, s] of Object.entries(topicSummaries)) {
    if (s && s.error) {
      out.push({
        topic,
        error_kind: s.error_kind || 'error',
        error_message: s.error_message || 'Summary failed.',
        error_detail: s.error_detail,
      });
    }
  }
  return out;
}

/**
 * Parks the record awaiting a user decision: status `needs_attention` plus the
 * `summaryErrors` list the popup renders. The record is left otherwise intact so
 * a "retry"/"skip" resume can pick up exactly where it stopped. `needs_attention`
 * is deliberately not an in-flight status, so the keepalive alarm won't auto-resume.
 *
 * @param {{key: string, pipelineRunId?: string, signal?: AbortSignal}} context
 * @param {Array<object>} summaryErrors
 * @param {'leaf'|'merge'} phase
 * @param {{done: number, total: number}} progress
 * @returns {Promise<void>}
 */
async function parkForReview(context, summaryErrors, phase, { done, total }) {
  await updatePipelineRecord(context, {
    status: 'needs_attention',
    summaryErrors,
    forceFinalize: false,
    progress: { stage: 'needs_attention', done, total },
  });
  await logPipeline(context, 'topic_summaries_needs_attention', {
    phase,
    errorCount: summaryErrors.length,
    topics: summaryErrors.map((e) => e.topic),
  });
}

/**
 * Per-topic leaf summaries followed by the topic-tree merge. Summaries that
 * already succeeded (present and not flagged with an error) are reused so a
 * resumed run only re-queries the LLM for the topics that are still missing or
 * previously failed — failed leaves are stored with `error: true`, while any
 * existing empty summary without that flag is treated as completed work. New
 * NO_SUMMARY responses fall back to source text before storage so parent merges
 * keep the topic's facts.
 *
 * @param {{key: string, pipelineRunId?: string, signal?: AbortSignal}} context
 * @param {Array<object>} topics
 * @param {string[]} sentenceTexts
 * When any leaf (or, later, any tree merge) is still failing after the built-in
 * retries, the run parks the record in `needs_attention` with a `summaryErrors`
 * list instead of silently finishing those topics empty. The UI surfaces a
 * confirm popup; the user's "retry"/"skip" decision resumes the pipeline. On a
 * "skip" resume `forceFinalize` is set so the run finishes to `done` accepting
 * the empties instead of parking again.
 *
 * @param {Record<string, {text: string, error?: boolean}>} previousSummaries
 * @param {boolean} [forceFinalize]
 * @returns {Promise<void>}
 */
async function runSummaries(
  context,
  topics,
  sentenceTexts,
  previousSummaries,
  forceFinalize = false,
) {
  // Plan: which topics reuse a stored summary vs. still need an LLM call.
  const { reused, pending, reusedCount, pendingCount, total } = planSummaryWork(
    topics,
    previousSummaries,
  );
  const topic_summaries = { ...reused };

  let done = reusedCount;
  await updatePipelineRecord(context, {
    progress: { stage: 'summarizing_topics', done, total },
  });
  if (pendingCount < total) {
    await logPipeline(context, 'topic_summaries_reused', {
      reusedCount,
      pendingCount,
      total,
    });
  }

  const pendingForLlm = [];
  let inlineCount = 0;
  for (const topic of pending) {
    const sourceText = topicSourceText(topic, sentenceTexts);
    if (shouldInlineTopicSummary(topic, sourceText)) {
      topic_summaries[topic.name] = {
        text: sourceText,
        source_sentences: topic.sentences,
      };
      done++;
      inlineCount++;
    } else {
      pendingForLlm.push({ topic, sourceText });
    }
  }
  if (inlineCount > 0) {
    await updatePipelineRecord(context, {
      topic_summaries: { ...topic_summaries },
      progress: { stage: 'summarizing_topics', done, total },
    });
    await logPipeline(context, 'topic_summaries_inlined', {
      inlineCount,
      pendingCount: pendingForLlm.length,
      maxSentences: INLINE_SUMMARY_MAX_SENTENCES,
      maxWords: INLINE_SUMMARY_MAX_WORDS,
      maxChars: INLINE_SUMMARY_MAX_CHARS,
    });
  }

  // Warm the provider's prompt/KV cache before the concurrent burst: every
  // summary prompt shares the same long instruction prefix, so running one
  // request to completion first lets a caching provider commit that prefix and
  // the rest reuse it instead of each re-prefilling it from cold. On a provider
  // without prefix caching it just costs one request of serial latency up front.
  if (pendingForLlm.length > 1) {
    await logPipeline(context, 'topic_summaries_warmup', {
      pendingCount: pendingForLlm.length,
      concurrency: SUMMARY_CONCURRENCY,
    });
  }
  await parallelMap(
    pendingForLlm,
    SUMMARY_CONCURRENCY,
    async ({ topic, sourceText }) => {
      await logPipeline(context, 'topic_summary_llm_request', {
        topic: topic.name,
        sentenceCount: topic.sentences.length,
      });
      const prompt = buildArticleSummaryPrompt(sourceText, {
        preferContentLanguage: context.preferContentLanguage,
      });
      let summaryText = '';
      let failure = null;
      try {
        const resp = await callLLMWithRetry({
          prompt,
          temperature: 0.8,
          signal: context.signal,
        });
        const parsed = parseSummaryResult(resp);
        summaryText = parsed.text || (parsed.noSummary ? sourceText : '');
        await logPipeline(context, 'topic_summary_llm_response', {
          topic: topic.name,
          responseLength: resp.length,
          summaryLength: summaryText.length,
        });
      } catch (e) {
        const { kind, message } = classifyLlmError(e);
        const detail = (e && e.message) || String(e);
        await logPipeline(context, 'topic_summary_llm_error', {
          topic: topic.name,
          error_kind: kind,
          error: message,
          detail,
        });
        failure = { error_kind: kind, error_message: message, error_detail: detail };
      }
      topic_summaries[topic.name] = {
        text: summaryText,
        source_sentences: topic.sentences,
        // Mark failures so a later resume retries only this topic, and carry a
        // helpful reason for the confirm popup. NO_SUMMARY responses fall back
        // to source text so parent merges still see the topic's facts.
        ...(failure ? { error: true, ...failure } : {}),
      };
      done++;
      await updatePipelineRecord(context, {
        topic_summaries: { ...topic_summaries },
        progress: { stage: 'summarizing_topics', done, total },
      });
    },
    { warmupFirst: true },
  );

  // Leaves that are still failing after the built-in retries park the run for a
  // user decision (unless this is a "skip" resume). Merging on top of failed
  // leaves would bury the failure as a degraded/empty parent summary, so we stop
  // before the merge.
  const leafErrors = collectSummaryErrors(topic_summaries);
  if (leafErrors.length && !forceFinalize) {
    await parkForReview(context, leafErrors, 'leaf', { done, total });
    return;
  }

  await logPipeline(context, 'topic_tree_merge_start', {
    leafCount: total,
  });
  const { nodes } = buildTopicTree(topics);

  // Internal-node summaries are generated from each node's own source text and
  // are independent of one another, so the topic-tree builder fans them out
  // concurrently. The limiter bounds the in-flight LLM calls a wide hierarchy
  // would otherwise fire at once and trip provider rate limits on (a 429
  // degrades a summary to empty). A "skip" finalize resolves every internal
  // node to empty without any LLM call.
  const limitSummary = createLimiter(SUMMARY_CONCURRENCY);
  const summaryErrors = [];
  const summarizeSource = forceFinalize
    ? async () => ({ text: '' })
    : makeSourceSummarizer(
        sentenceTexts,
        limitSummary,
        context.signal,
        context.preferContentLanguage,
      );
  const topic_summary_index = await summarizeTopicTree({
    nodes,
    leafSummaries: topic_summaries,
    summarizeSource,
    onError: ({ path, error }) => {
      const { kind, message } = classifyLlmError(error);
      summaryErrors.push({
        topic: path,
        error_kind: kind,
        error_message: message,
        error_detail: String(error),
      });
      return logPipeline(context, 'topic_tree_merge_error', {
        path,
        error_kind: kind,
        error: message,
      });
    },
  });
  await logPipeline(context, 'topic_tree_merge_done', {
    nodeCount: Object.keys(topic_summary_index).length,
  });

  // A merge that failed after retries left an empty parent summary; park the run
  // (same confirm popup) rather than silently shipping an empty topic. A "skip"
  // resume bypasses this and accepts the empty merge.
  if (summaryErrors.length && !forceFinalize) {
    await parkForReview(context, summaryErrors, 'merge', { done: total, total });
    return;
  }

  // The `error` flag (and its attached reason fields) is an in-flight-only
  // invariant: it exists so a run resumed mid-summarizing retries failed leaves,
  // or parks them for review. Once we reach the terminal 'done' state — either no
  // failures remained or the user chose "skip" — the flag is vestigial, so strip
  // it. A skipped failure resolves to empty text (recoverable via retry/reprocess).
  const finalizedSummaries = {};
  for (const [name, summary] of Object.entries(topic_summaries)) {
    finalizedSummaries[name] = {
      text: summary.text || '',
      source_sentences: summary.source_sentences,
    };
  }

  await updatePipelineRecord(context, {
    status: 'done',
    topic_summaries: finalizedSummaries,
    topic_summary_index,
    progress: { stage: 'done', done: total, total },
    // Clear any parked-review state now that the run has finalized.
    summaryErrors: [],
    forceFinalize: false,
  });
  await logPipeline(context, 'pipeline_done', {
    topicCount: total,
    summaryNodeCount: Object.keys(topic_summary_index).length,
  });
}
