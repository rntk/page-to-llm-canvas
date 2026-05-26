import { describe, it, expect } from "vitest";
import { parseSummaryResponse } from "./orchestrator.js";

describe("parseSummaryResponse", () => {
  it("keeps plain text summary output intact", () => {
    const raw = "The article covers a product launch.\n- The product ships in June.\n- Pricing starts at $20.";
    expect(parseSummaryResponse(raw)).toBe(raw);
  });

  it("trims surrounding whitespace", () => {
    expect(parseSummaryResponse("\n\nSummary line.\n- One fact.\n\n")).toBe(
      "Summary line.\n- One fact.",
    );
  });

  it("strips accidental markdown fences without parsing content", () => {
    const raw = "```json\n{\"text\":\"This stays plain text\",\"bullets\":[\"No parsing\"]}\n```";
    expect(parseSummaryResponse(raw)).toBe(
      "{\"text\":\"This stays plain text\",\"bullets\":[\"No parsing\"]}",
    );
  });

  it("returns an empty string for empty responses", () => {
    expect(parseSummaryResponse("")).toBe("");
    expect(parseSummaryResponse(null)).toBe("");
  });
});
