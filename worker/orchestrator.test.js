import { describe, it, expect, vi, beforeEach } from "vitest";
import { TopicParseError } from "./topic_parser.js";
import {
  runPipeline,
  chunkTaggedText,
  buildTopicTree,
  rangesToSentenceList,
  mapTextOffsetToHtml,
  parseSummaryResponse,
} from "./orchestrator.js";
import * as storage from "./storage.js";
import * as html from "./html.js";
import * as sentenceSplitter from "./sentence_splitter.js";
import * as llm from "./llm.js";

vi.mock("./storage.js", () => ({
  readRecord: vi.fn(),
  updateRecord: vi.fn(),
  appendProcessingLog: vi.fn(),
}));

vi.mock("./html.js", () => ({
  stripTagsKeepOffsets: vi.fn(),
}));

vi.mock("./sentence_splitter.js", () => ({
  splitSentences: vi.fn(),
}));

vi.mock("./llm.js", () => ({
  callLLMWithRetry: vi.fn(),
  parallelMap: vi.fn(async (items, limit, fn) => {
    const results = [];
    for (let i = 0; i < items.length; i++) {
      results.push(await fn(items[i], i));
    }
    return results;
  }),
}));

function makeMapping(text) {
  return Array.from({ length: text.length + 1 }, (_, i) => i);
}

function makeRecord(key, htmlContent) {
  return {
    key,
    html: htmlContent,
    status: "pending",
    topics: [],
    topic_summaries: {},
    topic_summary_index: {},
    processingLog: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(globalThis, "setTimeout").mockImplementation((fn) => {
    if (typeof fn === "function") fn();
    return 0;
  });
  storage.readRecord.mockResolvedValue(null);
  storage.updateRecord.mockImplementation(async (key, patch) => ({
    key,
    ...patch,
    updatedAt: Date.now(),
  }));
  storage.appendProcessingLog.mockResolvedValue(undefined);
  html.stripTagsKeepOffsets.mockReturnValue({ text: "", mapping: [0] });
  sentenceSplitter.splitSentences.mockReturnValue([]);
  llm.callLLMWithRetry.mockResolvedValue("");
});

// ---------------------------------------------------------------------------
// parseSummaryResponse (existing coverage preserved)
// ---------------------------------------------------------------------------

describe("parseSummaryResponse", () => {
  it("keeps plain text summary output intact", () => {
    const raw =
      "The article covers a product launch.\n- The product ships in June.\n- Pricing starts at $20.";
    expect(parseSummaryResponse(raw)).toBe(raw);
  });

  it("trims surrounding whitespace", () => {
    expect(parseSummaryResponse("\n\nSummary line.\n- One fact.\n\n")).toBe(
      "Summary line.\n- One fact.",
    );
  });

  it("strips accidental markdown fences without parsing content", () => {
    const raw =
      '```json\n{"text":"This stays plain text","bullets":["No parsing"]}\n```';
    expect(parseSummaryResponse(raw)).toBe(
      '{"text":"This stays plain text","bullets":["No parsing"]}',
    );
  });

  it("returns an empty string for empty responses", () => {
    expect(parseSummaryResponse("")).toBe("");
    expect(parseSummaryResponse(null)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// chunkTaggedText
// ---------------------------------------------------------------------------

describe("chunkTaggedText", () => {
  it("returns single chunk when under maxChars", () => {
    expect(chunkTaggedText("a\nb\nc", 100)).toEqual(["a\nb\nc"]);
  });

  it("splits into multiple chunks by line boundary", () => {
    const tagged = "line1\nline2\nline3\nline4";
    const result = chunkTaggedText(tagged, 12);
    expect(result).toEqual(["line1\nline2", "line3\nline4"]);
  });

  it("handles empty string", () => {
    expect(chunkTaggedText("", 10)).toEqual([""]);
  });

  it("does not split when a single line exceeds maxChars", () => {
    const tagged = "verylonglinewithoutnewlines";
    const result = chunkTaggedText(tagged, 10);
    expect(result).toEqual([tagged]);
  });
});

// ---------------------------------------------------------------------------
// buildTopicTree
// ---------------------------------------------------------------------------

describe("buildTopicTree", () => {
  it("builds a tree from flat hierarchical topics", () => {
    const topics = [
      { name: "Tech>AI", sentences: [1, 2] },
      { name: "Tech>Hardware", sentences: [3, 4] },
    ];
    const { root, nodes } = buildTopicTree(topics);
    expect(root.children).toHaveLength(1);
    expect(root.children[0].name).toBe("Tech");
    expect(root.children[0].children).toHaveLength(2);
    expect(nodes.get("Tech>AI").sourceSentences).toEqual([1, 2]);
    expect(nodes.get("Tech").sourceSentences).toEqual([1, 2, 3, 4]);
  });

  it("skips no_topic and missing names", () => {
    const topics = [
      { name: "Tech>AI", sentences: [1] },
      { name: "no_topic", sentences: [2] },
      { name: "", sentences: [3] },
    ];
    const { nodes } = buildTopicTree(topics);
    expect(nodes.has("Tech>AI")).toBe(true);
    expect(nodes.has("no_topic")).toBe(false);
  });

  it("deduplicates aggregated sentences across siblings", () => {
    const topics = [
      { name: "A>B", sentences: [1, 2, 3] },
      { name: "A>C", sentences: [3, 4] },
    ];
    const { nodes } = buildTopicTree(topics);
    expect(nodes.get("A").sourceSentences).toEqual([1, 2, 3, 4]);
  });

  it("returns root node with empty path", () => {
    const { root, nodes } = buildTopicTree([]);
    expect(root.path).toBe("");
    expect(nodes.get("")).toBe(root);
  });
});

// ---------------------------------------------------------------------------
// rangesToSentenceList
// ---------------------------------------------------------------------------

describe("rangesToSentenceList", () => {
  it("converts 0-based ranges to 1-based ordered unique list", () => {
    expect(
      rangesToSentenceList([{ start: 0, end: 2 }, { start: 5, end: 5 }]),
    ).toEqual([1, 2, 3, 6]);
  });

  it("handles empty ranges", () => {
    expect(rangesToSentenceList([])).toEqual([]);
  });

  it("deduplicates overlapping ranges", () => {
    expect(
      rangesToSentenceList([{ start: 0, end: 3 }, { start: 2, end: 5 }]),
    ).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("sorts out-of-order ranges", () => {
    expect(
      rangesToSentenceList([{ start: 5, end: 5 }, { start: 0, end: 1 }]),
    ).toEqual([1, 2, 6]);
  });
});

// ---------------------------------------------------------------------------
// mapTextOffsetToHtml
// ---------------------------------------------------------------------------

describe("mapTextOffsetToHtml", () => {
  it("maps valid offset directly", () => {
    const mapping = [10, 20, 30, 40];
    expect(mapTextOffsetToHtml(mapping, 1)).toBe(20);
  });

  it("clamps negative offset to 0", () => {
    const mapping = [10, 20, 30];
    expect(mapTextOffsetToHtml(mapping, -5)).toBe(10);
  });

  it("clamps overflow offset to last mapping entry", () => {
    const mapping = [10, 20, 30];
    expect(mapTextOffsetToHtml(mapping, 10)).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// runPipeline
// ---------------------------------------------------------------------------

describe("runPipeline", () => {
  it("runs the full pipeline for a single topic", async () => {
    const htmlText = "<p>Sentence one. Sentence two.</p>";
    const plainText = "Sentence one. Sentence two.";
    const mapping = makeMapping(plainText);

    storage.readRecord.mockResolvedValue(makeRecord("key1", htmlText));
    html.stripTagsKeepOffsets.mockReturnValue({ text: plainText, mapping });
    sentenceSplitter.splitSentences.mockReturnValue([
      { text: "Sentence one.", start: 0, end: 13 },
      { text: "Sentence two.", start: 14, end: 27 },
    ]);

    llm.callLLMWithRetry.mockImplementation(async ({ prompt }) => {
      if (prompt.includes("Partition the markers")) return "Tech>All: 0-1";
      if (prompt.includes("Summarize the article text")) return "Summary text.";
      return "";
    });

    await runPipeline("key1");

    const doneCall = storage.updateRecord.mock.calls.find(
      (call) => call[1].status === "done",
    );
    expect(doneCall).toBeDefined();
    const final = doneCall[1];
    expect(final.topic_summaries["Tech>All"].text).toBe("Summary text.");
    expect(final.topic_summary_index["Tech>All"].text).toBe("Summary text.");

    const topicCall = storage.updateRecord.mock.calls.find(
      (call) => call[1].topics && call[1].topics.length > 0,
    );
    expect(topicCall[1].topics[0].name).toBe("Tech>All");
  });

  it("marks done with empty topics when no sentences are found", async () => {
    storage.readRecord.mockResolvedValue(makeRecord("key2", "<p></p>"));
    html.stripTagsKeepOffsets.mockReturnValue({ text: "", mapping: [0] });
    sentenceSplitter.splitSentences.mockReturnValue([]);

    await runPipeline("key2");

    expect(storage.updateRecord).toHaveBeenCalledWith(
      "key2",
      expect.objectContaining({
        status: "done",
        topics: [],
        topic_summaries: {},
        progress: { stage: "done", done: 0, total: 0 },
      }),
    );
  });

  it("retries topic parsing on TopicParseError and eventually succeeds", async () => {
    const plainText = "A. B. C.";
    const mapping = makeMapping(plainText);
    storage.readRecord.mockResolvedValue(makeRecord("key3", "<p>A. B. C.</p>"));
    html.stripTagsKeepOffsets.mockReturnValue({ text: plainText, mapping });
    sentenceSplitter.splitSentences.mockReturnValue([
      { text: "A.", start: 0, end: 2 },
      { text: "B.", start: 3, end: 5 },
      { text: "C.", start: 6, end: 8 },
    ]);

    let attempt = 0;
    llm.callLLMWithRetry.mockImplementation(async ({ prompt }) => {
      if (prompt.includes("Partition the markers")) {
        attempt++;
        if (attempt === 1) return "Invalid response";
        return "Tech>All: 0-2";
      }
      if (prompt.includes("Summarize the article text")) return "Summary.";
      return "";
    });

    await runPipeline("key3");
    expect(attempt).toBe(2);

    const lastCall =
      storage.updateRecord.mock.calls[storage.updateRecord.mock.calls.length - 1];
    expect(lastCall[1].status).toBe("done");
  });

  it("throws when record is not found", async () => {
    storage.readRecord.mockResolvedValue(null);
    await expect(runPipeline("missing")).rejects.toThrow(
      "record not found: missing",
    );
  });

  it("stores error status and re-throws on pipeline failure", async () => {
    storage.readRecord.mockResolvedValue(makeRecord("key4", "<p>text</p>"));
    html.stripTagsKeepOffsets.mockImplementation(() => {
      throw new Error("HTML parse failed");
    });

    await expect(runPipeline("key4")).rejects.toThrow("HTML parse failed");

    expect(storage.updateRecord).toHaveBeenCalledWith(
      "key4",
      expect.objectContaining({
        status: "error",
        error: expect.stringContaining("HTML parse failed"),
      }),
    );
  });

  it("merges child summaries for hierarchical topics", async () => {
    const plainText = "A. B. C. D.";
    const mapping = makeMapping(plainText);
    storage.readRecord.mockResolvedValue(makeRecord("key5", "<p>A. B. C. D.</p>"));
    html.stripTagsKeepOffsets.mockReturnValue({ text: plainText, mapping });
    sentenceSplitter.splitSentences.mockReturnValue([
      { text: "A.", start: 0, end: 2 },
      { text: "B.", start: 3, end: 5 },
      { text: "C.", start: 6, end: 8 },
      { text: "D.", start: 9, end: 11 },
    ]);

    llm.callLLMWithRetry.mockImplementation(async ({ prompt }) => {
      if (prompt.includes("Partition the markers")) {
        return "Tech>AI: 0-1\nTech>Hardware: 2-3";
      }
      if (prompt.includes("Merge the chunk summaries")) {
        return "Merged tech summary.";
      }
      return "Topic summary.";
    });

    await runPipeline("key5");

    const lastCall =
      storage.updateRecord.mock.calls[storage.updateRecord.mock.calls.length - 1];
    expect(lastCall[1].status).toBe("done");
    expect(lastCall[1].topic_summary_index).toBeDefined();
    expect(lastCall[1].topic_summary_index["Tech"].text).toBe(
      "Merged tech summary.",
    );
  });

  it("handles LLM summary errors gracefully per topic", async () => {
    const plainText = "A. B.";
    const mapping = makeMapping(plainText);
    storage.readRecord.mockResolvedValue(makeRecord("key6", "<p>A. B.</p>"));
    html.stripTagsKeepOffsets.mockReturnValue({ text: plainText, mapping });
    sentenceSplitter.splitSentences.mockReturnValue([
      { text: "A.", start: 0, end: 2 },
      { text: "B.", start: 3, end: 5 },
    ]);

    llm.callLLMWithRetry.mockImplementation(async ({ prompt }) => {
      if (prompt.includes("Partition the markers")) return "Tech>All: 0-1";
      if (prompt.includes("Summarize the article text"))
        throw new Error("LLM down");
      return "";
    });

    await runPipeline("key6");

    const lastCall =
      storage.updateRecord.mock.calls[storage.updateRecord.mock.calls.length - 1];
    expect(lastCall[1].topic_summaries["Tech>All"].text).toBe("");
  });

  it("chunks tagged text when it exceeds MAX_TAGGED_CHARS", async () => {
    const htmlText = "<p>x</p>";
    const plainText = "x".repeat(30000);
    const mapping = makeMapping(plainText);

    storage.readRecord.mockResolvedValue(makeRecord("key7", htmlText));
    html.stripTagsKeepOffsets.mockReturnValue({ text: plainText, mapping });

    const sentences = Array.from({ length: 3000 }, (_, i) => ({
      text: `Sentence ${i} with enough extra padding to make each line fairly long indeed.`,
      start: i * 100,
      end: i * 100 + 70,
    }));
    sentenceSplitter.splitSentences.mockReturnValue(sentences);

    let chunkCount = 0;
    llm.callLLMWithRetry.mockImplementation(async ({ prompt }) => {
      if (prompt.includes("Partition the markers")) {
        chunkCount++;
        return `Tech>All: 0-${sentences.length - 1}`;
      }
      if (prompt.includes("Summarize the article text")) return "Summary.";
      return "";
    });

    await runPipeline("key7");
    expect(chunkCount).toBeGreaterThan(1);
    expect(storage.updateRecord).toHaveBeenCalledWith(
      "key7",
      expect.objectContaining({ status: "done" }),
    );
  });

  it("propagates non-TopicParseError immediately without retry", async () => {
    const plainText = "A. B.";
    const mapping = makeMapping(plainText);
    storage.readRecord.mockResolvedValue(makeRecord("key8", "<p>A. B.</p>"));
    html.stripTagsKeepOffsets.mockReturnValue({ text: plainText, mapping });
    sentenceSplitter.splitSentences.mockReturnValue([
      { text: "A.", start: 0, end: 2 },
      { text: "B.", start: 3, end: 5 },
    ]);

    llm.callLLMWithRetry.mockImplementation(async ({ prompt }) => {
      if (prompt.includes("Partition the markers")) {
        throw new TypeError("Unexpected");
      }
      if (prompt.includes("Summarize the article text")) return "Summary.";
      return "";
    });

    await expect(runPipeline("key8")).rejects.toThrow("Unexpected");
  });

  it("sets topic spans with correct HTML offsets", async () => {
    const plainText = "AB. CD.";
    const mapping = [0, 10, 20, 30, 40, 50, 60, 70];
    storage.readRecord.mockResolvedValue(makeRecord("key9", "<p>AB. CD.</p>"));
    html.stripTagsKeepOffsets.mockReturnValue({ text: plainText, mapping });
    sentenceSplitter.splitSentences.mockReturnValue([
      { text: "AB.", start: 0, end: 3 },
      { text: "CD.", start: 4, end: 7 },
    ]);

    llm.callLLMWithRetry.mockImplementation(async ({ prompt }) => {
      if (prompt.includes("Partition the markers")) return "Tech>All: 0-1";
      if (prompt.includes("Summarize the article text")) return "Summary.";
      return "";
    });

    await runPipeline("key9");

    const topicCall = storage.updateRecord.mock.calls.find(
      (call) => call[1].topics && call[1].status === "summarizing",
    );
    expect(topicCall).toBeDefined();
    const topics = topicCall[1].topics;
    expect(topics[0].sentence_spans).toEqual([
      { sentence: 1, start: 0, end: 30 },
      { sentence: 2, start: 40, end: 70 },
    ]);
    expect(topics[0].ranges).toEqual([
      { sentence_start: 1, sentence_end: 2, start: 0, end: 70 },
    ]);
  });
});
