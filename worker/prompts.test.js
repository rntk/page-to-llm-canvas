import { describe, it, expect } from "vitest";
import {
  buildSystemPrompt,
  buildTopicRangesPrompt,
  buildArticleSummaryPrompt,
  buildArticleSummaryMergePrompt,
  buildSentenceSummaryPrompt,
  buildTaggedText,
  formatChunkSummariesForMerge,
  SENTENCE_SUMMARY_PROMPT_TEMPLATE,
  ARTICLE_SUMMARY_PROMPT_TEMPLATE,
  ARTICLE_SUMMARY_MERGE_PROMPT_TEMPLATE,
} from "./prompts.js";

describe("buildSystemPrompt", () => {
  it("returns a non-empty string", () => {
    const prompt = buildSystemPrompt();
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });

  it("contains hierarchy and assignment rules", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("HIERARCHY RULES");
    expect(prompt).toContain("ASSIGNMENT RULES");
  });

  it("contains security rules", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("SECURITY");
    expect(prompt).toContain("UNTRUSTED USER DATA");
  });
});

describe("buildTopicRangesPrompt", () => {
  it("includes the system prompt", () => {
    const prompt = buildTopicRangesPrompt("{0} hello");
    const systemPrompt = buildSystemPrompt();
    expect(prompt).toContain(systemPrompt);
  });

  it("includes the tagged text in content tags", () => {
    const tagged = "{0} hello world";
    const prompt = buildTopicRangesPrompt(tagged);
    expect(prompt).toContain(`<content>\n${tagged}\n</content>`);
  });

  it("includes output format instructions", () => {
    const prompt = buildTopicRangesPrompt("text");
    expect(prompt).toContain("OUTPUT FORMAT");
    expect(prompt).toContain("Category>Subcategory>SpecificTopic: MarkerRanges");
  });
});

describe("buildArticleSummaryPrompt", () => {
  it("replaces {text} placeholder with provided text", () => {
    const prompt = buildArticleSummaryPrompt("My article text");
    expect(prompt).toContain("My article text");
    expect(prompt).not.toContain("{text}");
  });

  it("instructs summaries to lead with substance", () => {
    const prompt = buildArticleSummaryPrompt("My article text");
    expect(prompt).toContain("Begin with the substance itself");
  });
});

describe("buildArticleSummaryMergePrompt", () => {
  it("replaces {chunk_summaries} placeholder", () => {
    const summaries = "Chunk 1: summary one";
    const prompt = buildArticleSummaryMergePrompt(summaries);
    expect(prompt).toContain(summaries);
    expect(prompt).not.toContain("{chunk_summaries}");
  });

  it("instructs merged summaries to lead with substance", () => {
    const prompt = buildArticleSummaryMergePrompt("Chunk 1: summary one");
    expect(prompt).toContain("Begin with the substance itself");
  });
});

describe("buildSentenceSummaryPrompt", () => {
  it("replaces {sentence} placeholder", () => {
    const prompt = buildSentenceSummaryPrompt("The quick brown fox.");
    expect(prompt).toContain("The quick brown fox.");
    expect(prompt).not.toContain("{sentence}");
  });

  it("instructs sentence summaries to lead with substance", () => {
    const prompt = buildSentenceSummaryPrompt("The quick brown fox.");
    expect(prompt).toContain("Begin with the substance itself");
  });
});

describe("buildTaggedText", () => {
  it("prefixes each sentence with {N}", () => {
    const result = buildTaggedText(["Hello.", "World."]);
    expect(result).toBe("{0} Hello.\n{1} World.");
  });

  it("handles string sentences", () => {
    const result = buildTaggedText(["alpha", "beta"]);
    expect(result).toContain("{0} alpha");
    expect(result).toContain("{1} beta");
  });

  it("handles object sentences with .text property", () => {
    const result = buildTaggedText([{ text: "alpha" }, { text: "beta" }]);
    expect(result).toContain("{0} alpha");
    expect(result).toContain("{1} beta");
  });

  it("returns empty string for empty array", () => {
    expect(buildTaggedText([])).toBe("");
  });
});

describe("formatChunkSummariesForMerge", () => {
  it("formats each record with chunk number and sentence range", () => {
    const records = [
      { start_sentence: 0, end_sentence: 5, summary: { text: "Chunk one summary." } },
      { start_sentence: 6, end_sentence: 10, summary: { text: "Chunk two summary." } },
    ];
    const result = formatChunkSummariesForMerge(records);
    expect(result).toContain("Chunk 1 (sentences 0-5)");
    expect(result).toContain("Chunk one summary.");
    expect(result).toContain("Chunk 2 (sentences 6-10)");
    expect(result).toContain("Chunk two summary.");
  });

  it("handles missing summary gracefully", () => {
    const records = [{ start_sentence: 0, end_sentence: 3 }];
    const result = formatChunkSummariesForMerge(records);
    expect(result).toContain("Chunk 1 (sentences 0-3)");
  });
});

describe("prompt template constants", () => {
  it("SENTENCE_SUMMARY_PROMPT_TEMPLATE contains {sentence} placeholder", () => {
    expect(SENTENCE_SUMMARY_PROMPT_TEMPLATE).toContain("{sentence}");
  });

  it("ARTICLE_SUMMARY_PROMPT_TEMPLATE contains {text} placeholder", () => {
    expect(ARTICLE_SUMMARY_PROMPT_TEMPLATE).toContain("{text}");
  });

  it("ARTICLE_SUMMARY_MERGE_PROMPT_TEMPLATE contains {chunk_summaries} placeholder", () => {
    expect(ARTICLE_SUMMARY_MERGE_PROMPT_TEMPLATE).toContain("{chunk_summaries}");
  });
});
