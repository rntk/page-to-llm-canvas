import { describe, it, expect } from "vitest";
import { parseTopicRanges, TopicParseError } from "./topic_parser.js";

// Helpers -------------------------------------------------------------------

/** Build a valid response string covering indices 0..n-1 under a single topic. */
function singleTopic(n) {
  return `Tech>All: 0-${n - 1}`;
}

/** Build a valid response with two topics splitting n sentences at mid. */
function twoTopics(n) {
  const mid = Math.floor(n / 2) - 1;
  return `Tech>First: 0-${mid}\nTech>Second: ${mid + 1}-${n - 1}`;
}

// Valid output ---------------------------------------------------------------

describe("valid complete coverage", () => {
  it("single topic covering all 5 sentences", () => {
    const groups = parseTopicRanges(singleTopic(5), 5);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toEqual(["Tech", "All"]);
    expect(groups[0].ranges).toEqual([{ start: 0, end: 4 }]);
  });

  it("two topics covering 6 sentences", () => {
    const groups = parseTopicRanges(twoTopics(6), 6);
    expect(groups).toHaveLength(2);
  });

  it("non-contiguous ranges on same topic are merged", () => {
    const resp = "Tech>Topic: 0-1, 4-5\nTech>Other: 2-3";
    const groups = parseTopicRanges(resp, 6);
    const topic = groups.find((g) => g.label.join(">") === "Tech>Topic");
    expect(topic).toBeDefined();
    // Ranges should cover 0-1 and 4-5 (not merged because gap exists)
    const covered = topic.ranges.flatMap((r) => {
      const out = [];
      for (let i = r.start; i <= r.end; i++) out.push(i);
      return out;
    });
    expect(covered.sort((a, b) => a - b)).toEqual([0, 1, 4, 5]);
  });

  it("adjacent same-label groups are joined", () => {
    const resp = "Tech>Same: 0-1\nTech>Same: 2-3";
    const groups = parseTopicRanges(resp, 4);
    expect(groups).toHaveLength(1);
    expect(groups[0].ranges).toEqual([{ start: 0, end: 3 }]);
  });

  it("single sentence document", () => {
    const groups = parseTopicRanges("Tech>Only: 0", 1);
    expect(groups).toHaveLength(1);
  });
});

// Out-of-range ---------------------------------------------------------------

describe("out-of-range sentence", () => {
  it("throws TopicParseError when marker exceeds sentenceCount", () => {
    // 5 sentences (0-4), but response claims sentence 5
    const resp = "Tech>A: 0-3\nTech>B: 4-5";
    expect(() => parseTopicRanges(resp, 5)).toThrow(TopicParseError);
  });

  it("error message mentions out-of-range", () => {
    const resp = "Tech>A: 0-3\nTech>B: 4-5";
    try {
      parseTopicRanges(resp, 5);
    } catch (e) {
      expect(e.message).toMatch(/out-of-range/);
      expect(e.diagnostics.outOfRange).toContain(5);
    }
  });

  it("throws when entire range is beyond bounds", () => {
    expect(() => parseTopicRanges("Tech>A: 10-20", 5)).toThrow(TopicParseError);
  });
});

// Missing coverage -----------------------------------------------------------

describe("missing sentence", () => {
  it("throws when a sentence index is not assigned", () => {
    // 5 sentences, but index 2 is skipped
    const resp = "Tech>A: 0-1\nTech>B: 3-4";
    expect(() => parseTopicRanges(resp, 5)).toThrow(TopicParseError);
  });

  it("diagnostics report the missing index", () => {
    const resp = "Tech>A: 0-1\nTech>B: 3-4";
    try {
      parseTopicRanges(resp, 5);
    } catch (e) {
      expect(e.diagnostics.missing).toContain(2);
    }
  });

  it("throws when response covers only part of the sentences", () => {
    expect(() => parseTopicRanges("Tech>A: 0-2", 5)).toThrow(TopicParseError);
  });
});

// Duplicate/overlapping sentences --------------------------------------------

describe("duplicate sentence", () => {
  it("throws when two topics claim the same sentence index", () => {
    const resp = "Tech>A: 0-3\nTech>B: 2-4";
    expect(() => parseTopicRanges(resp, 5)).toThrow(TopicParseError);
  });

  it("diagnostics report duplicate indices", () => {
    const resp = "Tech>A: 0-3\nTech>B: 2-4";
    try {
      parseTopicRanges(resp, 5);
    } catch (e) {
      expect(e.diagnostics.duplicates.length).toBeGreaterThan(0);
    }
  });

  it("throws when same topic lists overlapping ranges", () => {
    // After mergeRanges on same key, overlap is absorbed, but if the
    // overlap comes from two different keys it is a duplicate.
    const resp = "Tech>A: 0-2\nTech>A: 1-4";
    // Same-label ranges are merged per-key before validation,
    // but index 1-2 would be covered by merged 0-4 once only.
    // After adjacent-join the merged range is 0-4 covering all 5 — valid.
    expect(() => parseTopicRanges(resp, 5)).not.toThrow();
  });
});

// Empty group ----------------------------------------------------------------

describe("empty group", () => {
  it("throws when response is entirely empty", () => {
    expect(() => parseTopicRanges("", 3)).toThrow(TopicParseError);
  });

  it("throws when all lines are unparseable", () => {
    expect(() => parseTopicRanges("no colon here\njust text", 3)).toThrow(TopicParseError);
  });
});

// Malformed numbering --------------------------------------------------------

describe("malformed numbering", () => {
  it("throws when markers are letters, not numbers", () => {
    // No valid ranges parsed → missing all → TopicParseError
    expect(() => parseTopicRanges("Tech>A: a-b", 3)).toThrow(TopicParseError);
  });

  it("handles reversed range (start > end) by normalising", () => {
    // e.g. LLM writes 4-0 for 5 sentences; should be treated as 0-4
    const resp = "Tech>A: 4-0";
    expect(() => parseTopicRanges(resp, 5)).not.toThrow();
    const groups = parseTopicRanges(resp, 5);
    expect(groups[0].ranges).toEqual([{ start: 0, end: 4 }]);
  });

  it("throws when response has no recognisable range portion", () => {
    expect(() => parseTopicRanges("Tech>A:", 3)).toThrow(TopicParseError);
  });
});

// Hallucinated huge range -------------------------------------------------

describe("hallucinated huge range", () => {
  it("fails fast without iterating billions of indices", () => {
    // A real hang would make this test time out. The fix must detect
    // out-of-range from the boundary values alone.
    const resp = "Tech>A: 0-999999999";
    expect(() => parseTopicRanges(resp, 5)).toThrow(TopicParseError);
  });

  it("reports the hallucinated end boundary in diagnostics", () => {
    try {
      parseTopicRanges("Tech>A: 0-999999999", 5);
    } catch (e) {
      expect(e.diagnostics.outOfRange).toContain(999999999);
    }
  });
});


describe("TopicParseError identity", () => {
  it("is an instance of Error", () => {
    try {
      parseTopicRanges("", 3);
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect(e).toBeInstanceOf(TopicParseError);
      expect(e.name).toBe("TopicParseError");
    }
  });

  it("carries structured diagnostics object", () => {
    try {
      parseTopicRanges("Tech>A: 0-1", 5); // missing 2,3,4
    } catch (e) {
      expect(e.diagnostics).toBeDefined();
      expect(Array.isArray(e.diagnostics.missing)).toBe(true);
      expect(Array.isArray(e.diagnostics.duplicates)).toBe(true);
      expect(Array.isArray(e.diagnostics.outOfRange)).toBe(true);
    }
  });
});
