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
  formatChunkSummariesForMerge,
} from './prompts.js';
import { parseTopicRanges, groupsFromSegments, TopicParseError } from './topic_parser.js';
import { callLLMWithRetry, parallelMap } from './llm.js';

const MAX_TAGGED_CHARS = 60000;
const SUMMARY_CONCURRENCY = 4;
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
 * @param {string} key
 * @param {string} stage
 * @param {Record<string, unknown>} [details]
 * @returns {Promise<void>}
 */
async function logPipeline(key, stage, details = {}) {
  console.info('PageToLLM Canvas pipeline:', stage, details);
  await appendProcessingLog(key, stage, details).catch((err) => {
    console.warn('PageToLLM Canvas pipeline log failed:', err);
  });
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

export function parseSummaryResponse(raw) {
  if (!raw) return '';
  let s = raw.trim();

  s = s
    .replace(/^```[a-z0-9_-]*\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  if (/^NO_SUMMARY\.?$/i.test(s)) return '';
  return s;
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

async function mergeChildSummaries(childRecords) {
  const prompt = buildArticleSummaryMergePrompt(formatChunkSummariesForMerge(childRecords));
  const resp = await callLLMWithRetry({ prompt, temperature: 0.8 });
  return { text: parseSummaryResponse(resp) };
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
 * @param {string} key
 * @param {{label: string[], start: number, end: number}} seg
 * @param {string[]} sentenceTexts
 * @param {number} depth
 * @returns {Promise<Array<{label: string[], start: number, end: number}> | null>}
 */
async function resplitSegment(key, seg, sentenceTexts, depth) {
  const span = seg.end - seg.start + 1;
  const sliceTexts = sentenceTexts.slice(seg.start, seg.end + 1);
  const tagged = buildTaggedText(sliceTexts);
  const chunks =
    tagged.length > MAX_TAGGED_CHARS ? chunkTaggedText(tagged, MAX_TAGGED_CHARS) : [tagged];

  await logPipeline(key, 'topic_ranges_resplit_request', {
    start: seg.start,
    end: seg.end,
    span,
    depth,
    chunkCount: chunks.length,
  });

  const responses = [];
  for (const chunk of chunks) {
    const prompt = buildTopicRangesPrompt(chunk);
    try {
      responses.push(await callLLMWithRetry({ prompt, temperature: 0.8 }));
    } catch (e) {
      await logPipeline(key, 'topic_ranges_resplit_error', {
        start: seg.start,
        end: seg.end,
        depth,
        error: (e && e.message) || String(e),
      });
      return null;
    }
  }

  let subGroups;
  try {
    subGroups = parseTopicRanges(responses.join('\n'), sliceTexts.length);
  } catch (e) {
    await logPipeline(key, 'topic_ranges_resplit_error', {
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
    await logPipeline(key, 'topic_ranges_resplit_no_progress', {
      start: seg.start,
      end: seg.end,
      span,
      depth,
    });
    return null;
  }

  await logPipeline(key, 'topic_ranges_resplit_response', {
    start: seg.start,
    end: seg.end,
    span,
    depth,
    subSegmentCount: subSegments.length,
  });

  // Recurse into any sub-segment that is still oversized, up to the depth bound.
  if (depth + 1 < TOPIC_RANGE_RESPLIT_MAX_DEPTH) {
    const expanded = [];
    for (const s of subSegments) {
      if (s.end - s.start + 1 > TOPIC_RANGE_MAX_SENTENCES) {
        const deeper = await resplitSegment(key, s, sentenceTexts, depth + 1);
        if (deeper) {
          expanded.push(...deeper);
          continue;
        }
      }
      expanded.push(s);
    }
    subSegments = expanded;
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
 * @param {string} key
 * @param {Array<{label: string[], ranges: Array<{start: number, end: number}>}>} groups
 * @param {string[]} sentenceTexts
 * @returns {Promise<Array<{label: string[], ranges: Array<{start: number, end: number}>}>>}
 */
async function refineOversizedRanges(key, groups, sentenceTexts) {
  const segments = [];
  for (const g of groups) {
    for (const r of g.ranges) {
      segments.push({ label: g.label, start: r.start, end: r.end });
    }
  }
  segments.sort((a, b) => a.start - b.start);

  const oversized = segments.filter((s) => s.end - s.start + 1 > TOPIC_RANGE_MAX_SENTENCES);
  if (!oversized.length) return groups;

  await logPipeline(key, 'topic_ranges_oversize_detected', {
    oversizeCount: oversized.length,
    maxSentences: TOPIC_RANGE_MAX_SENTENCES,
    spans: oversized.map((s) => s.end - s.start + 1),
  });

  let changed = false;
  const refined = [];
  for (const seg of segments) {
    if (seg.end - seg.start + 1 > TOPIC_RANGE_MAX_SENTENCES) {
      const subSegments = await resplitSegment(key, seg, sentenceTexts, 0);
      if (subSegments && subSegments.length > 1) {
        refined.push(...subSegments);
        changed = true;
        continue;
      }
    }
    refined.push(seg);
  }

  if (!changed) return groups;

  const regrouped = groupsFromSegments(refined, sentenceTexts.length);
  await logPipeline(key, 'topic_ranges_oversize_refined', {
    groupCountBefore: groups.length,
    groupCountAfter: regrouped.length,
  });
  return regrouped;
}

export async function runPipeline(key) {
  try {
    await logPipeline(key, 'pipeline_start');
    const rec = await readRecord(key);
    if (!rec) throw new Error(`record not found: ${key}`);

    await updateRecord(key, {
      status: 'splitting',
      progress: { stage: 'cleaning_html', done: 0, total: 0 },
      error: null,
    });
    await logPipeline(key, 'cleaning_html_start', {
      htmlLength: String(rec.html || '').length,
    });

    const { text, mapping } = stripTagsKeepOffsets(rec.html || '');
    await logPipeline(key, 'cleaning_html_done', {
      textLength: text.length,
      mappingLength: mapping.length,
    });

    await updateRecord(key, {
      text,
      progress: { stage: 'splitting_sentences', done: 0, total: 0 },
    });
    await logPipeline(key, 'splitting_sentences_start');

    const sentenceObjs = splitSentences(text);
    const sentenceTexts = sentenceObjs.map((s) => s.text);
    await logPipeline(key, 'splitting_sentences_done', {
      sentenceCount: sentenceTexts.length,
    });

    await updateRecord(key, {
      sentences: sentenceTexts,
      progress: { stage: 'topic_ranges', done: 0, total: sentenceTexts.length },
    });

    if (sentenceTexts.length === 0) {
      await updateRecord(key, {
        status: 'done',
        topics: [],
        topic_summaries: {},
        progress: { stage: 'done', done: 0, total: 0 },
      });
      return;
    }

    const tagged = buildTaggedText(sentenceTexts);
    const chunks =
      tagged.length > MAX_TAGGED_CHARS ? chunkTaggedText(tagged, MAX_TAGGED_CHARS) : [tagged];
    await logPipeline(key, 'topic_ranges_start', {
      taggedLength: tagged.length,
      chunkCount: chunks.length,
    });

    let groups;
    for (let topicAttempt = 0; topicAttempt <= TOPIC_RANGE_MAX_RETRIES; topicAttempt++) {
      const responses = [];
      for (const [chunkIndex, chunk] of chunks.entries()) {
        const prompt = buildTopicRangesPrompt(chunk);
        await logPipeline(key, 'topic_ranges_llm_request', {
          chunkIndex,
          promptLength: prompt.length,
          attempt: topicAttempt + 1,
        });
        const resp = await callLLMWithRetry({ prompt, temperature: 0.8 });
        await logPipeline(key, 'topic_ranges_llm_response', {
          chunkIndex,
          responseLength: resp.length,
          attempt: topicAttempt + 1,
        });
        responses.push(resp);
      }
      const combined = responses.join('\n');
      try {
        groups = parseTopicRanges(combined, sentenceTexts.length);
        break;
      } catch (e) {
        if (!(e instanceof TopicParseError) || topicAttempt >= TOPIC_RANGE_MAX_RETRIES) throw e;
        await logPipeline(key, 'topic_ranges_parse_retry', {
          attempt: topicAttempt + 1,
          maxRetries: TOPIC_RANGE_MAX_RETRIES,
          error: e.message,
        });
        const delay = TOPIC_RANGE_RETRY_BASE_DELAY_MS * Math.pow(2, topicAttempt);
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    try {
      groups = await refineOversizedRanges(key, groups, sentenceTexts);
    } catch (e) {
      // Refinement is best-effort; never fail the pipeline over an oversized range.
      await logPipeline(key, 'topic_ranges_oversize_error', {
        error: (e && e.message) || String(e),
      });
    }

    await logPipeline(key, 'topic_ranges_done', {
      groupCount: groups.length,
    });

    const topics = groups.map((g) => {
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

    await updateRecord(key, {
      topics,
      status: 'summarizing',
      progress: { stage: 'summarizing_topics', done: 0, total: topics.length },
    });

    const topic_summaries = {};
    let done = 0;
    await parallelMap(topics, SUMMARY_CONCURRENCY, async (topic) => {
      await logPipeline(key, 'topic_summary_llm_request', {
        topic: topic.name,
        sentenceCount: topic.sentences.length,
      });
      const sourceText = topic.sentences
        .map((oneIdx) => sentenceTexts[oneIdx - 1])
        .filter(Boolean)
        .join(' ');
      const prompt = buildArticleSummaryPrompt(sourceText);
      let summaryText;
      try {
        const resp = await callLLMWithRetry({ prompt, temperature: 0.8 });
        summaryText = parseSummaryResponse(resp);
        await logPipeline(key, 'topic_summary_llm_response', {
          topic: topic.name,
          responseLength: resp.length,
          summaryLength: summaryText.length,
        });
      } catch (e) {
        await logPipeline(key, 'topic_summary_llm_error', {
          topic: topic.name,
          error: (e && e.message) || String(e),
        });
        summaryText = '';
      }
      topic_summaries[topic.name] = {
        text: summaryText,
        source_sentences: topic.sentences,
      };
      done++;
      await updateRecord(key, {
        topic_summaries: { ...topic_summaries },
        progress: { stage: 'summarizing_topics', done, total: topics.length },
      });
    });

    await logPipeline(key, 'topic_tree_merge_start', {
      leafCount: topics.length,
    });
    const { root, nodes } = buildTopicTree(topics);
    for (const [path, node] of nodes) {
      if (path && topic_summaries[path]) {
        node.leafSummary = {
          text: topic_summaries[path].text || '',
        };
      }
    }

    async function summarizeNode(node) {
      for (const child of node.children) await summarizeNode(child);
      if (node.children.length === 0) {
        node.summary = node.leafSummary || { text: '' };
        return;
      }
      if (node.children.length === 1) {
        node.summary = node.children[0].summary;
        return;
      }
      const records = node.children.map((c) => {
        const sents = c.sourceSentences;
        return {
          start_sentence: sents[0] || 0,
          end_sentence: sents[sents.length - 1] || 0,
          summary: c.summary || { text: '' },
        };
      });
      try {
        node.summary = await mergeChildSummaries(records);
      } catch (e) {
        await logPipeline(key, 'topic_tree_merge_error', {
          path: node.path,
          error: (e && e.message) || String(e),
        });
        node.summary = { text: '' };
      }
    }
    await summarizeNode(root);

    const topic_summary_index = {};
    for (const [path, node] of nodes) {
      if (!path) continue;
      topic_summary_index[path] = {
        text: (node.summary && node.summary.text) || '',
        level: node.level - 1,
        source_sentences: node.sourceSentences,
      };
    }
    await logPipeline(key, 'topic_tree_merge_done', {
      nodeCount: Object.keys(topic_summary_index).length,
    });

    await updateRecord(key, {
      status: 'done',
      topic_summaries,
      topic_summary_index,
      progress: { stage: 'done', done: topics.length, total: topics.length },
    });
    await logPipeline(key, 'pipeline_done', {
      topicCount: topics.length,
      summaryNodeCount: Object.keys(topic_summary_index).length,
    });
  } catch (e) {
    await logPipeline(key, 'pipeline_error', {
      error: String(e && e.stack ? e.stack : e),
    });
    await updateRecord(key, {
      status: 'error',
      error: String(e && e.stack ? e.stack : e),
    }).catch((writeErr) => {
      console.error('PageToLLM Canvas: failed to persist error status to storage:', writeErr);
    });
    throw e;
  }
}
