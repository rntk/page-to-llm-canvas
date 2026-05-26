// Pipeline entry point: clean HTML, split sentences, LLM topic ranges, per-topic summaries.
// NOTE: This module runs in the service worker context (background.js), not
// inside the modal iframe. It is kept in the worker/ directory for historical
// reasons, but it is no longer bundled into the modal UI.

import { appendProcessingLog, readRecord, updateRecord } from "./storage.js";
import { stripTagsKeepOffsets } from "./html.js";
import { splitSentences } from "./sentence_splitter.js";
import {
  buildTaggedText,
  buildTopicRangesPrompt,
  buildArticleSummaryPrompt,
  buildArticleSummaryMergePrompt,
  formatChunkSummariesForMerge,
} from "./prompts.js";
import { parseTopicRanges } from "./topic_parser.js";
import { callLLMWithRetry, parallelMap } from "./llm.js";

const MAX_TAGGED_CHARS = 60000;
const SUMMARY_CONCURRENCY = 4;

/**
 * @param {string} key
 * @param {string} stage
 * @param {Record<string, unknown>} [details]
 * @returns {Promise<void>}
 */
async function logPipeline(key, stage, details = {}) {
  console.info("PageToLLM Canvas pipeline:", stage, details);
  await appendProcessingLog(key, stage, details).catch((err) => {
    console.warn("PageToLLM Canvas pipeline log failed:", err);
  });
}

function chunkTaggedText(tagged, maxChars) {
  const lines = tagged.split("\n");
  const chunks = [];
  let cur = [];
  let curLen = 0;
  for (const line of lines) {
    const lineLen = line.length + 1;
    if (curLen + lineLen > maxChars && cur.length > 0) {
      chunks.push(cur.join("\n"));
      cur = [];
      curLen = 0;
    }
    cur.push(line);
    curLen += lineLen;
  }
  if (cur.length) chunks.push(cur.join("\n"));
  return chunks;
}

function parseSummaryResponse(raw) {
  if (!raw) return { text: "", bullets: [] };
  let s = raw.trim();
  // Strip markdown fences if present.
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  // Attempt to locate JSON object if surrounded by extra text.
  if (s[0] !== "{") {
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start >= 0 && end > start) s = s.slice(start, end + 1);
  }
  try {
    const obj = JSON.parse(s);
    return {
      text: typeof obj.text === "string" ? obj.text : "",
      bullets: Array.isArray(obj.bullets) ? obj.bullets.filter((b) => typeof b === "string") : [],
    };
  } catch {
    return { text: raw.slice(0, 200), bullets: [] };
  }
}

function buildTopicTree(topics) {
  const root = { path: "", name: "", level: 0, children: [], leafSummary: null, sourceSentences: [] };
  const nodes = new Map([["", root]]);

  function getOrCreate(path) {
    if (nodes.has(path)) return nodes.get(path);
    const parts = path.split(">");
    const parentPath = parts.slice(0, -1).join(">");
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
    if (!topic.name || topic.name === "no_topic") continue;
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
  const prompt = buildArticleSummaryMergePrompt(
    formatChunkSummariesForMerge(childRecords),
  );
  const resp = await callLLMWithRetry({ prompt, temperature: 0.0 });
  return parseSummaryResponse(resp);
}

function rangesToSentenceList(ranges) {
  // ranges are 0-based inclusive; output 1-based ordered unique list.
  const set = new Set();
  for (const r of ranges) {
    for (let i = r.start; i <= r.end; i++) set.add(i);
  }
  return Array.from(set).sort((a, b) => a - b).map((i) => i + 1);
}

function mapTextOffsetToHtml(mapping, textOffset) {
  if (textOffset < 0) textOffset = 0;
  if (textOffset >= mapping.length) textOffset = mapping.length - 1;
  return mapping[textOffset];
}

export async function runPipeline(key) {
  try {
    await logPipeline(key, "pipeline_start");
    const rec = await readRecord(key);
    if (!rec) throw new Error(`record not found: ${key}`);

    await updateRecord(key, {
      status: "splitting",
      progress: { stage: "cleaning_html", done: 0, total: 0 },
      error: null,
    });
    await logPipeline(key, "cleaning_html_start", {
      htmlLength: String(rec.html || "").length,
    });

    const { text, mapping } = stripTagsKeepOffsets(rec.html || "");
    await logPipeline(key, "cleaning_html_done", {
      textLength: text.length,
      mappingLength: mapping.length,
    });

    await updateRecord(key, {
      text,
      progress: { stage: "splitting_sentences", done: 0, total: 0 },
    });
    await logPipeline(key, "splitting_sentences_start");

    const sentenceObjs = splitSentences(text);
    const sentenceTexts = sentenceObjs.map((s) => s.text);
    await logPipeline(key, "splitting_sentences_done", {
      sentenceCount: sentenceTexts.length,
    });

    await updateRecord(key, {
      sentences: sentenceTexts,
      progress: { stage: "topic_ranges", done: 0, total: sentenceTexts.length },
    });

    if (sentenceTexts.length === 0) {
      await updateRecord(key, {
        status: "done",
        topics: [],
        topic_summaries: {},
        progress: { stage: "done", done: 0, total: 0 },
      });
      return;
    }

    const tagged = buildTaggedText(sentenceTexts);
    const chunks = tagged.length > MAX_TAGGED_CHARS ? chunkTaggedText(tagged, MAX_TAGGED_CHARS) : [tagged];
    await logPipeline(key, "topic_ranges_start", {
      taggedLength: tagged.length,
      chunkCount: chunks.length,
    });

    const responses = [];
    for (const [chunkIndex, chunk] of chunks.entries()) {
      const prompt = buildTopicRangesPrompt(chunk);
      await logPipeline(key, "topic_ranges_llm_request", {
        chunkIndex,
        promptLength: prompt.length,
      });
      const resp = await callLLMWithRetry({ prompt, temperature: 0.0 });
      await logPipeline(key, "topic_ranges_llm_response", {
        chunkIndex,
        responseLength: resp.length,
      });
      responses.push(resp);
    }
    const combined = responses.join("\n");

    const groups = parseTopicRanges(combined, sentenceTexts.length);
    await logPipeline(key, "topic_ranges_done", {
      groupCount: groups.length,
    });

    const topics = groups.map((g) => {
      const name = g.label.join(">");
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
      status: "summarizing",
      progress: { stage: "summarizing_topics", done: 0, total: topics.length },
    });

    const topic_summaries = {};
    let done = 0;
    await parallelMap(topics, SUMMARY_CONCURRENCY, async (topic) => {
      await logPipeline(key, "topic_summary_llm_request", {
        topic: topic.name,
        sentenceCount: topic.sentences.length,
      });
      const sourceText = topic.sentences
        .map((oneIdx) => sentenceTexts[oneIdx - 1])
        .filter(Boolean)
        .join(" ");
      const prompt = buildArticleSummaryPrompt(sourceText);
      let parsed;
      try {
        const resp = await callLLMWithRetry({ prompt, temperature: 0.0 });
        parsed = parseSummaryResponse(resp);
        await logPipeline(key, "topic_summary_llm_response", {
          topic: topic.name,
          responseLength: resp.length,
          bulletCount: parsed.bullets.length,
        });
      } catch (e) {
        await logPipeline(key, "topic_summary_llm_error", {
          topic: topic.name,
          error: (e && e.message) || String(e),
        });
        parsed = { text: "", bullets: [] };
      }
      topic_summaries[topic.name] = {
        text: parsed.text,
        bullets: parsed.bullets,
        source_sentences: topic.sentences,
      };
      done++;
      await updateRecord(key, {
        topic_summaries: { ...topic_summaries },
        progress: { stage: "summarizing_topics", done, total: topics.length },
      });
    });

    await logPipeline(key, "topic_tree_merge_start", {
      leafCount: topics.length,
    });
    const { root, nodes } = buildTopicTree(topics);
    for (const [path, node] of nodes) {
      if (path && topic_summaries[path]) {
        node.leafSummary = {
          text: topic_summaries[path].text || "",
          bullets: topic_summaries[path].bullets || [],
        };
      }
    }

    async function summarizeNode(node) {
      for (const child of node.children) await summarizeNode(child);
      if (node.children.length === 0) {
        node.summary = node.leafSummary || { text: "", bullets: [] };
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
          summary: c.summary || { text: "", bullets: [] },
        };
      });
      try {
        node.summary = await mergeChildSummaries(records);
      } catch (e) {
        await logPipeline(key, "topic_tree_merge_error", {
          path: node.path,
          error: (e && e.message) || String(e),
        });
        node.summary = { text: "", bullets: [] };
      }
    }
    await summarizeNode(root);

    const topic_summary_index = {};
    for (const [path, node] of nodes) {
      if (!path) continue;
      topic_summary_index[path] = {
        text: (node.summary && node.summary.text) || "",
        bullets: (node.summary && node.summary.bullets) || [],
        level: node.level - 1,
        source_sentences: node.sourceSentences,
      };
    }
    await logPipeline(key, "topic_tree_merge_done", {
      nodeCount: Object.keys(topic_summary_index).length,
    });

    await updateRecord(key, {
      status: "done",
      topic_summaries,
      topic_summary_index,
      progress: { stage: "done", done: topics.length, total: topics.length },
    });
    await logPipeline(key, "pipeline_done", {
      topicCount: topics.length,
      summaryNodeCount: Object.keys(topic_summary_index).length,
    });
  } catch (e) {
    await logPipeline(key, "pipeline_error", {
      error: String(e && e.stack ? e.stack : e),
    });
    await updateRecord(key, {
      status: "error",
      error: String(e && e.stack ? e.stack : e),
    }).catch((writeErr) => {
      console.error("PageToLLM Canvas: failed to persist error status to storage:", writeErr);
    });
    throw e;
  }
}
