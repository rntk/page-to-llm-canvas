import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  runPipeline,
  chunkTaggedText,
  buildTopicTree,
  rangesToSentenceList,
  mapTextOffsetToHtml,
  parseSummaryResponse,
} from './orchestrator.js';
import * as storage from './storage.js';
import * as html from './html.js';
import * as sentenceSplitter from './sentence_splitter.js';
import * as llm from './llm.js';

vi.mock('./storage.js', () => ({
  readRecord: vi.fn(),
  updateRecord: vi.fn(),
  appendProcessingLog: vi.fn(),
}));

vi.mock('./html.js', () => ({
  stripTagsKeepOffsets: vi.fn(),
}));

vi.mock('./sentence_splitter.js', () => ({
  splitSentences: vi.fn(),
}));

vi.mock('./llm.js', () => ({
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
    status: 'pending',
    topics: [],
    topic_summaries: {},
    topic_summary_index: {},
    processingLog: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn) => {
    if (typeof fn === 'function') fn();
    return 0;
  });
  storage.readRecord.mockResolvedValue(null);
  storage.updateRecord.mockImplementation(async (key, patch) => ({
    key,
    ...patch,
    updatedAt: Date.now(),
  }));
  storage.appendProcessingLog.mockResolvedValue(undefined);
  html.stripTagsKeepOffsets.mockReturnValue({ text: '', mapping: [0] });
  sentenceSplitter.splitSentences.mockReturnValue([]);
  llm.callLLMWithRetry.mockResolvedValue('');
});

// ---------------------------------------------------------------------------
// parseSummaryResponse (existing coverage preserved)
// ---------------------------------------------------------------------------

describe('parseSummaryResponse', () => {
  it('keeps plain text summary output intact', () => {
    const raw =
      'The article covers a product launch.\n- The product ships in June.\n- Pricing starts at $20.';
    expect(parseSummaryResponse(raw)).toBe(raw);
  });

  it('trims surrounding whitespace', () => {
    expect(parseSummaryResponse('\n\nSummary line.\n- One fact.\n\n')).toBe(
      'Summary line.\n- One fact.',
    );
  });

  it('strips accidental markdown fences without parsing content', () => {
    const raw = '```json\n{"text":"This stays plain text","bullets":["No parsing"]}\n```';
    expect(parseSummaryResponse(raw)).toBe(
      '{"text":"This stays plain text","bullets":["No parsing"]}',
    );
  });

  it('returns an empty string for empty responses', () => {
    expect(parseSummaryResponse('')).toBe('');
    expect(parseSummaryResponse(null)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// chunkTaggedText
// ---------------------------------------------------------------------------

describe('chunkTaggedText', () => {
  it('returns single chunk when under maxChars', () => {
    expect(chunkTaggedText('a\nb\nc', 100)).toEqual(['a\nb\nc']);
  });

  it('splits into multiple chunks by line boundary', () => {
    const tagged = 'line1\nline2\nline3\nline4';
    const result = chunkTaggedText(tagged, 12);
    expect(result).toEqual(['line1\nline2', 'line3\nline4']);
  });

  it('handles empty string', () => {
    expect(chunkTaggedText('', 10)).toEqual(['']);
  });

  it('does not split when a single line exceeds maxChars', () => {
    const tagged = 'verylonglinewithoutnewlines';
    const result = chunkTaggedText(tagged, 10);
    expect(result).toEqual([tagged]);
  });
});

// ---------------------------------------------------------------------------
// buildTopicTree
// ---------------------------------------------------------------------------

describe('buildTopicTree', () => {
  it('builds a tree from flat hierarchical topics', () => {
    const topics = [
      { name: 'Tech>AI', sentences: [1, 2] },
      { name: 'Tech>Hardware', sentences: [3, 4] },
    ];
    const { root, nodes } = buildTopicTree(topics);
    expect(root.children).toHaveLength(1);
    expect(root.children[0].name).toBe('Tech');
    expect(root.children[0].children).toHaveLength(2);
    expect(nodes.get('Tech>AI').sourceSentences).toEqual([1, 2]);
    expect(nodes.get('Tech').sourceSentences).toEqual([1, 2, 3, 4]);
  });

  it('skips no_topic and missing names', () => {
    const topics = [
      { name: 'Tech>AI', sentences: [1] },
      { name: 'no_topic', sentences: [2] },
      { name: '', sentences: [3] },
    ];
    const { nodes } = buildTopicTree(topics);
    expect(nodes.has('Tech>AI')).toBe(true);
    expect(nodes.has('no_topic')).toBe(false);
  });

  it('deduplicates aggregated sentences across siblings', () => {
    const topics = [
      { name: 'A>B', sentences: [1, 2, 3] },
      { name: 'A>C', sentences: [3, 4] },
    ];
    const { nodes } = buildTopicTree(topics);
    expect(nodes.get('A').sourceSentences).toEqual([1, 2, 3, 4]);
  });

  it('returns root node with empty path', () => {
    const { root, nodes } = buildTopicTree([]);
    expect(root.path).toBe('');
    expect(nodes.get('')).toBe(root);
  });
});

// ---------------------------------------------------------------------------
// rangesToSentenceList
// ---------------------------------------------------------------------------

describe('rangesToSentenceList', () => {
  it('converts 0-based ranges to 1-based ordered unique list', () => {
    expect(
      rangesToSentenceList([
        { start: 0, end: 2 },
        { start: 5, end: 5 },
      ]),
    ).toEqual([1, 2, 3, 6]);
  });

  it('handles empty ranges', () => {
    expect(rangesToSentenceList([])).toEqual([]);
  });

  it('deduplicates overlapping ranges', () => {
    expect(
      rangesToSentenceList([
        { start: 0, end: 3 },
        { start: 2, end: 5 },
      ]),
    ).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('sorts out-of-order ranges', () => {
    expect(
      rangesToSentenceList([
        { start: 5, end: 5 },
        { start: 0, end: 1 },
      ]),
    ).toEqual([1, 2, 6]);
  });
});

// ---------------------------------------------------------------------------
// mapTextOffsetToHtml
// ---------------------------------------------------------------------------

describe('mapTextOffsetToHtml', () => {
  it('maps valid offset directly', () => {
    const mapping = [10, 20, 30, 40];
    expect(mapTextOffsetToHtml(mapping, 1)).toBe(20);
  });

  it('clamps negative offset to 0', () => {
    const mapping = [10, 20, 30];
    expect(mapTextOffsetToHtml(mapping, -5)).toBe(10);
  });

  it('clamps overflow offset to last mapping entry', () => {
    const mapping = [10, 20, 30];
    expect(mapTextOffsetToHtml(mapping, 10)).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// runPipeline
// ---------------------------------------------------------------------------

describe('runPipeline', () => {
  it('runs the full pipeline for a single topic', async () => {
    const htmlText = '<p>Sentence one. Sentence two.</p>';
    const plainText = 'Sentence one. Sentence two.';
    const mapping = makeMapping(plainText);

    storage.readRecord.mockResolvedValue(makeRecord('key1', htmlText));
    html.stripTagsKeepOffsets.mockReturnValue({ text: plainText, mapping });
    sentenceSplitter.splitSentences.mockReturnValue([
      { text: 'Sentence one.', start: 0, end: 13 },
      { text: 'Sentence two.', start: 14, end: 27 },
    ]);

    llm.callLLMWithRetry.mockImplementation(async ({ prompt }) => {
      if (prompt.includes('Partition the markers')) return 'Tech>All: 0-1';
      if (prompt.includes('Summarize the article text')) return 'Summary text.';
      return '';
    });

    await runPipeline('key1');

    const doneCall = storage.updateRecord.mock.calls.find((call) => call[1].status === 'done');
    expect(doneCall).toBeDefined();
    const final = doneCall[1];
    expect(final.topic_summaries['Tech>All'].text).toBe('Summary text.');
    expect(final.topic_summary_index['Tech>All'].text).toBe('Summary text.');

    const topicCall = storage.updateRecord.mock.calls.find(
      (call) => call[1].topics && call[1].topics.length > 0,
    );
    expect(topicCall[1].topics[0].name).toBe('Tech>All');
  });

  it('marks done with empty topics when no sentences are found', async () => {
    storage.readRecord.mockResolvedValue(makeRecord('key2', '<p></p>'));
    html.stripTagsKeepOffsets.mockReturnValue({ text: '', mapping: [0] });
    sentenceSplitter.splitSentences.mockReturnValue([]);

    await runPipeline('key2');

    expect(storage.updateRecord).toHaveBeenCalledWith(
      'key2',
      expect.objectContaining({
        status: 'done',
        topics: [],
        topic_summaries: {},
        progress: { stage: 'done', done: 0, total: 0 },
      }),
    );
  });

  it('retries topic parsing on TopicParseError and eventually succeeds', async () => {
    const plainText = 'A. B. C.';
    const mapping = makeMapping(plainText);
    storage.readRecord.mockResolvedValue(makeRecord('key3', '<p>A. B. C.</p>'));
    html.stripTagsKeepOffsets.mockReturnValue({ text: plainText, mapping });
    sentenceSplitter.splitSentences.mockReturnValue([
      { text: 'A.', start: 0, end: 2 },
      { text: 'B.', start: 3, end: 5 },
      { text: 'C.', start: 6, end: 8 },
    ]);

    let attempt = 0;
    llm.callLLMWithRetry.mockImplementation(async ({ prompt }) => {
      if (prompt.includes('Partition the markers')) {
        attempt++;
        if (attempt === 1) return 'Invalid response';
        return 'Tech>All: 0-2';
      }
      if (prompt.includes('Summarize the article text')) return 'Summary.';
      return '';
    });

    await runPipeline('key3');
    expect(attempt).toBe(2);

    const lastCall = storage.updateRecord.mock.calls[storage.updateRecord.mock.calls.length - 1];
    expect(lastCall[1].status).toBe('done');
  });

  it('throws when record is not found', async () => {
    storage.readRecord.mockResolvedValue(null);
    await expect(runPipeline('missing')).rejects.toThrow('record not found: missing');
  });

  it('stores error status and re-throws on pipeline failure', async () => {
    storage.readRecord.mockResolvedValue(makeRecord('key4', '<p>text</p>'));
    html.stripTagsKeepOffsets.mockImplementation(() => {
      throw new Error('HTML parse failed');
    });

    await expect(runPipeline('key4')).rejects.toThrow('HTML parse failed');

    expect(storage.updateRecord).toHaveBeenCalledWith(
      'key4',
      expect.objectContaining({
        status: 'error',
        error: expect.stringContaining('HTML parse failed'),
      }),
    );
  });

  it('merges child summaries for hierarchical topics', async () => {
    const plainText = 'A. B. C. D.';
    const mapping = makeMapping(plainText);
    storage.readRecord.mockResolvedValue(makeRecord('key5', '<p>A. B. C. D.</p>'));
    html.stripTagsKeepOffsets.mockReturnValue({ text: plainText, mapping });
    sentenceSplitter.splitSentences.mockReturnValue([
      { text: 'A.', start: 0, end: 2 },
      { text: 'B.', start: 3, end: 5 },
      { text: 'C.', start: 6, end: 8 },
      { text: 'D.', start: 9, end: 11 },
    ]);

    llm.callLLMWithRetry.mockImplementation(async ({ prompt }) => {
      if (prompt.includes('Partition the markers')) {
        return 'Tech>AI: 0-1\nTech>Hardware: 2-3';
      }
      if (prompt.includes('Merge the chunk summaries')) {
        return 'Merged tech summary.';
      }
      return 'Topic summary.';
    });

    await runPipeline('key5');

    const lastCall = storage.updateRecord.mock.calls[storage.updateRecord.mock.calls.length - 1];
    expect(lastCall[1].status).toBe('done');
    expect(lastCall[1].topic_summary_index).toBeDefined();
    expect(lastCall[1].topic_summary_index['Tech'].text).toBe('Merged tech summary.');
  });

  it('handles LLM summary errors gracefully per topic', async () => {
    const plainText = 'A. B.';
    const mapping = makeMapping(plainText);
    storage.readRecord.mockResolvedValue(makeRecord('key6', '<p>A. B.</p>'));
    html.stripTagsKeepOffsets.mockReturnValue({ text: plainText, mapping });
    sentenceSplitter.splitSentences.mockReturnValue([
      { text: 'A.', start: 0, end: 2 },
      { text: 'B.', start: 3, end: 5 },
    ]);

    llm.callLLMWithRetry.mockImplementation(async ({ prompt }) => {
      if (prompt.includes('Partition the markers')) return 'Tech>All: 0-1';
      if (prompt.includes('Summarize the article text')) throw new Error('LLM down');
      return '';
    });

    await runPipeline('key6');

    const lastCall = storage.updateRecord.mock.calls[storage.updateRecord.mock.calls.length - 1];
    expect(lastCall[1].topic_summaries['Tech>All'].text).toBe('');
  });

  it('chunks tagged text when it exceeds MAX_TAGGED_CHARS', async () => {
    const htmlText = '<p>x</p>';
    const plainText = 'x'.repeat(30000);
    const mapping = makeMapping(plainText);

    storage.readRecord.mockResolvedValue(makeRecord('key7', htmlText));
    html.stripTagsKeepOffsets.mockReturnValue({ text: plainText, mapping });

    const sentences = Array.from({ length: 3000 }, (_, i) => ({
      text: `Sentence ${i} with enough extra padding to make each line fairly long indeed.`,
      start: i * 100,
      end: i * 100 + 70,
    }));
    sentenceSplitter.splitSentences.mockReturnValue(sentences);

    let chunkCount = 0;
    llm.callLLMWithRetry.mockImplementation(async ({ prompt }) => {
      if (prompt.includes('Partition the markers')) {
        chunkCount++;
        return `Tech>All: 0-${sentences.length - 1}`;
      }
      if (prompt.includes('Summarize the article text')) return 'Summary.';
      return '';
    });

    await runPipeline('key7');
    expect(chunkCount).toBeGreaterThan(1);
    expect(storage.updateRecord).toHaveBeenCalledWith(
      'key7',
      expect.objectContaining({ status: 'done' }),
    );
  });

  it('re-splits an oversized topic range via additional LLM calls', async () => {
    // 60 sentences > TOPIC_RANGE_MAX_SENTENCES (40): the first partition lumps
    // them into one topic, the re-split call subdivides into two.
    const n = 60;
    const plainText = Array.from({ length: n }, (_, i) => `S${i}.`).join(' ');
    const mapping = makeMapping(plainText);
    storage.readRecord.mockResolvedValue(makeRecord('keyBig', `<p>${plainText}</p>`));
    html.stripTagsKeepOffsets.mockReturnValue({ text: plainText, mapping });
    sentenceSplitter.splitSentences.mockReturnValue(
      Array.from({ length: n }, (_, i) => ({ text: `S${i}.`, start: i * 4, end: i * 4 + 3 })),
    );

    let partitionCalls = 0;
    llm.callLLMWithRetry.mockImplementation(async ({ prompt }) => {
      if (prompt.includes('Partition the markers')) {
        partitionCalls++;
        // First call: one giant topic. Re-split call(s): subdivide the slice
        // (which is re-tagged with local 0-based markers, so 0-29 / 30-59).
        if (partitionCalls === 1) return `Tech>All: 0-${n - 1}`;
        return 'Tech>FirstHalf: 0-29\nTech>SecondHalf: 30-59';
      }
      if (prompt.includes('Summarize the article text')) return 'Summary.';
      return '';
    });

    await runPipeline('keyBig');

    expect(partitionCalls).toBeGreaterThan(1);
    const topicCall = storage.updateRecord.mock.calls.find(
      (call) => call[1].topics && call[1].status === 'summarizing',
    );
    const names = topicCall[1].topics.map((t) => t.name);
    expect(names).toEqual(['Tech>FirstHalf', 'Tech>SecondHalf']);
    // Coverage of the original range is preserved across the subdivision.
    expect(topicCall[1].topics[0].sentences).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    expect(topicCall[1].topics[1].sentences).toEqual(Array.from({ length: 30 }, (_, i) => i + 31));
  });

  it('keeps the original range when a re-split makes no progress', async () => {
    // The re-split call insists the slice is still a single topic, so the
    // oversized range is left intact rather than looping.
    const n = 60;
    const plainText = Array.from({ length: n }, (_, i) => `S${i}.`).join(' ');
    const mapping = makeMapping(plainText);
    storage.readRecord.mockResolvedValue(makeRecord('keyBig2', `<p>${plainText}</p>`));
    html.stripTagsKeepOffsets.mockReturnValue({ text: plainText, mapping });
    sentenceSplitter.splitSentences.mockReturnValue(
      Array.from({ length: n }, (_, i) => ({ text: `S${i}.`, start: i * 4, end: i * 4 + 3 })),
    );

    let partitionCalls = 0;
    llm.callLLMWithRetry.mockImplementation(async ({ prompt }) => {
      if (prompt.includes('Partition the markers')) {
        partitionCalls++;
        return `Tech>All: 0-${n - 1}`;
      }
      if (prompt.includes('Summarize the article text')) return 'Summary.';
      return '';
    });

    await runPipeline('keyBig2');

    // One re-split was attempted (no progress), then we stopped — no loop.
    expect(partitionCalls).toBe(2);
    const topicCall = storage.updateRecord.mock.calls.find(
      (call) => call[1].topics && call[1].status === 'summarizing',
    );
    expect(topicCall[1].topics.map((t) => t.name)).toEqual(['Tech>All']);
    const doneCall = storage.updateRecord.mock.calls.find((call) => call[1].status === 'done');
    expect(doneCall).toBeDefined();
  });

  it('recursively re-splits a sub-segment that is still oversized', async () => {
    // First partition: one giant topic (90 sentences). First re-split yields a
    // small head and a still-oversized tail (60 > 40), which a second-level
    // re-split subdivides — exercising the depth recursion.
    const n = 90;
    const plainText = Array.from({ length: n }, (_, i) => `S${i}.`).join(' ');
    const mapping = makeMapping(plainText);
    storage.readRecord.mockResolvedValue(makeRecord('keyDeep', `<p>${plainText}</p>`));
    html.stripTagsKeepOffsets.mockReturnValue({ text: plainText, mapping });
    sentenceSplitter.splitSentences.mockReturnValue(
      Array.from({ length: n }, (_, i) => ({ text: `S${i}.`, start: i * 4, end: i * 4 + 3 })),
    );

    let partitionCalls = 0;
    llm.callLLMWithRetry.mockImplementation(async ({ prompt }) => {
      if (prompt.includes('Partition the markers')) {
        partitionCalls++;
        if (partitionCalls === 1) return `Tech>All: 0-${n - 1}`;
        if (partitionCalls === 2) {
          // Slice is the full 90: a 30-sentence head + a 60-sentence tail.
          return 'Tech>Head: 0-29\nTech>Tail: 30-89';
        }
        // Second-level re-split of the 60-sentence tail slice (local 0-59).
        return 'Tech>TailA: 0-29\nTech>TailB: 30-59';
      }
      if (prompt.includes('Summarize the article text')) return 'Summary.';
      return '';
    });

    await runPipeline('keyDeep');

    expect(partitionCalls).toBe(3);
    const topicCall = storage.updateRecord.mock.calls.find(
      (call) => call[1].topics && call[1].status === 'summarizing',
    );
    expect(topicCall[1].topics.map((t) => t.name)).toEqual([
      'Tech>Head',
      'Tech>TailA',
      'Tech>TailB',
    ]);
    // Global offsets: Head 1-30, TailA 31-60, TailB 61-90.
    expect(topicCall[1].topics[1].sentences[0]).toBe(31);
    expect(topicCall[1].topics[2].sentences[0]).toBe(61);
    expect(topicCall[1].topics[2].sentences.at(-1)).toBe(90);
  });

  it('propagates non-TopicParseError immediately without retry', async () => {
    const plainText = 'A. B.';
    const mapping = makeMapping(plainText);
    storage.readRecord.mockResolvedValue(makeRecord('key8', '<p>A. B.</p>'));
    html.stripTagsKeepOffsets.mockReturnValue({ text: plainText, mapping });
    sentenceSplitter.splitSentences.mockReturnValue([
      { text: 'A.', start: 0, end: 2 },
      { text: 'B.', start: 3, end: 5 },
    ]);

    llm.callLLMWithRetry.mockImplementation(async ({ prompt }) => {
      if (prompt.includes('Partition the markers')) {
        throw new TypeError('Unexpected');
      }
      if (prompt.includes('Summarize the article text')) return 'Summary.';
      return '';
    });

    await expect(runPipeline('key8')).rejects.toThrow('Unexpected');
  });

  it('sets topic spans with correct HTML offsets', async () => {
    const plainText = 'AB. CD.';
    const mapping = [0, 10, 20, 30, 40, 50, 60, 70];
    storage.readRecord.mockResolvedValue(makeRecord('key9', '<p>AB. CD.</p>'));
    html.stripTagsKeepOffsets.mockReturnValue({ text: plainText, mapping });
    sentenceSplitter.splitSentences.mockReturnValue([
      { text: 'AB.', start: 0, end: 3 },
      { text: 'CD.', start: 4, end: 7 },
    ]);

    llm.callLLMWithRetry.mockImplementation(async ({ prompt }) => {
      if (prompt.includes('Partition the markers')) return 'Tech>All: 0-1';
      if (prompt.includes('Summarize the article text')) return 'Summary.';
      return '';
    });

    await runPipeline('key9');

    const topicCall = storage.updateRecord.mock.calls.find(
      (call) => call[1].topics && call[1].status === 'summarizing',
    );
    expect(topicCall).toBeDefined();
    const topics = topicCall[1].topics;
    expect(topics[0].sentence_spans).toEqual([
      { sentence: 1, start: 0, end: 30 },
      { sentence: 2, start: 40, end: 70 },
    ]);
    expect(topics[0].ranges).toEqual([{ sentence_start: 1, sentence_end: 2, start: 0, end: 70 }]);
  });

  it('resumes a summarizing record without redoing topic ranges and only summarizes missing topics', async () => {
    // A record left in 'summarizing' with topics + one completed summary, as
    // happens after a service-worker recycle mid-summary.
    storage.readRecord.mockResolvedValue({
      key: 'resume1',
      html: '<p>ignored on resume</p>',
      status: 'summarizing',
      sentences: ['Alpha.', 'Beta.'],
      topics: [
        { name: 'A', sentences: [1], sentence_spans: [], ranges: [] },
        { name: 'B', sentences: [2], sentence_spans: [], ranges: [] },
      ],
      topic_summaries: {
        A: { text: 'Existing A summary.', source_sentences: [1] },
      },
      topic_summary_index: {},
    });

    const summaryPrompts = [];
    llm.callLLMWithRetry.mockImplementation(async ({ prompt }) => {
      if (prompt.includes('Partition the markers')) return 'SHOULD_NOT_BE_CALLED: 0-1';
      if (prompt.includes('Summarize the article text')) {
        summaryPrompts.push(prompt);
        return 'Fresh B summary.';
      }
      return '';
    });

    await runPipeline('resume1');

    // Topic-ranges stage must be skipped entirely on resume.
    const topicRangeCalls = llm.callLLMWithRetry.mock.calls.filter((c) =>
      c[0].prompt.includes('Partition the markers'),
    );
    expect(topicRangeCalls).toHaveLength(0);
    // HTML cleaning / sentence splitting must be skipped too.
    expect(html.stripTagsKeepOffsets).not.toHaveBeenCalled();
    expect(sentenceSplitter.splitSentences).not.toHaveBeenCalled();

    // Only the missing topic (B) should be summarized; A is reused.
    expect(summaryPrompts).toHaveLength(1);
    expect(summaryPrompts[0]).toContain('Beta.');

    const doneCall = storage.updateRecord.mock.calls.find((call) => call[1].status === 'done');
    expect(doneCall).toBeDefined();
    expect(doneCall[1].topic_summaries.A.text).toBe('Existing A summary.');
    expect(doneCall[1].topic_summaries.B.text).toBe('Fresh B summary.');
  });

  it('retries only summaries flagged with an error, keeping legit empty (NO_SUMMARY) results', async () => {
    storage.readRecord.mockResolvedValue({
      key: 'resume2',
      html: '<p>ignored</p>',
      status: 'summarizing',
      sentences: ['Alpha.', 'Beta.', 'Gamma.'],
      topics: [
        { name: 'A', sentences: [1], sentence_spans: [], ranges: [] },
        { name: 'B', sentences: [2], sentence_spans: [], ranges: [] },
        { name: 'C', sentences: [3], sentence_spans: [], ranges: [] },
      ],
      topic_summaries: {
        A: { text: 'Good A.', source_sentences: [1] },
        B: { text: '', source_sentences: [2] }, // legit NO_SUMMARY — keep
        C: { text: '', source_sentences: [3], error: true }, // failed — retry
      },
      topic_summary_index: {},
    });

    const summaryPrompts = [];
    llm.callLLMWithRetry.mockImplementation(async ({ prompt }) => {
      if (prompt.includes('Summarize the article text')) {
        summaryPrompts.push(prompt);
        return 'Recovered C.';
      }
      return '';
    });

    await runPipeline('resume2');

    // Only the errored topic C is re-queried.
    expect(summaryPrompts).toHaveLength(1);
    expect(summaryPrompts[0]).toContain('Gamma.');

    const doneCall = storage.updateRecord.mock.calls.find((call) => call[1].status === 'done');
    expect(doneCall[1].topic_summaries.A.text).toBe('Good A.');
    expect(doneCall[1].topic_summaries.B.text).toBe('');
    expect(doneCall[1].topic_summaries.C.text).toBe('Recovered C.');
    expect(doneCall[1].topic_summaries.C.error).toBeUndefined();
  });

  it('flags a failed summary with error:true while summarizing, but strips it once done', async () => {
    storage.readRecord.mockResolvedValue(makeRecord('failmark', '<p>One. Two.</p>'));
    html.stripTagsKeepOffsets.mockReturnValue({
      text: 'One. Two.',
      mapping: makeMapping('One. Two.'),
    });
    sentenceSplitter.splitSentences.mockReturnValue([
      { text: 'One.', start: 0, end: 4 },
      { text: 'Two.', start: 5, end: 9 },
    ]);
    llm.callLLMWithRetry.mockImplementation(async ({ prompt }) => {
      if (prompt.includes('Partition the markers')) return 'Tech>All: 0-1';
      if (prompt.includes('Summarize the article text')) throw new Error('LLM down');
      return '';
    });

    await runPipeline('failmark');

    // Production side: while summarizing, the failed leaf is persisted with the
    // error flag so a recycle-resume retries it instead of reusing empty text.
    const inFlightFlagged = storage.updateRecord.mock.calls.find(
      (call) => call[1].topic_summaries && call[1].topic_summaries['Tech>All']?.error === true,
    );
    expect(inFlightFlagged).toBeDefined();

    // Terminal side: the flag is an in-flight-only invariant and must not leak
    // into the done record — the leaf resolves to plain empty text.
    const doneCall = storage.updateRecord.mock.calls.find((call) => call[1].status === 'done');
    expect(doneCall[1].topic_summaries['Tech>All'].text).toBe('');
    expect(doneCall[1].topic_summaries['Tech>All'].error).toBeUndefined();
  });

  it('clears stale topics and summaries on a fresh run (non-resume path)', async () => {
    storage.readRecord.mockResolvedValue({
      key: 'fresh1',
      html: '<p>One. Two.</p>',
      status: 'pending',
      topics: [{ name: 'StaleTopic', sentences: [1], sentence_spans: [], ranges: [] }],
      topic_summaries: {
        StaleTopic: { text: 'Old summary.', source_sentences: [1] },
      },
      topic_summary_index: { StaleTopic: { text: 'Old' } },
    });

    html.stripTagsKeepOffsets.mockReturnValue({
      text: 'One. Two.',
      mapping: makeMapping('One. Two.'),
    });
    sentenceSplitter.splitSentences.mockReturnValue([
      { text: 'One.', start: 0, end: 4 },
      { text: 'Two.', start: 5, end: 9 },
    ]);
    llm.callLLMWithRetry.mockImplementation(async ({ prompt }) => {
      if (prompt.includes('Partition the markers')) return 'Tech>All: 0-1';
      if (prompt.includes('Summarize the article text')) return 'Fresh summary.';
      return '';
    });

    await runPipeline('fresh1');

    // The first updateRecord call must have cleared topics and summaries.
    const firstUpdateCall = storage.updateRecord.mock.calls[0];
    expect(firstUpdateCall[1]).toEqual({
      status: 'splitting',
      progress: { stage: 'cleaning_html', done: 0, total: 0 },
      error: null,
      topics: [],
      topic_summaries: {},
      topic_summary_index: {},
    });

    // The final result has only the fresh summaries.
    const doneCall = storage.updateRecord.mock.calls.find((call) => call[1].status === 'done');
    expect(doneCall[1].topic_summaries.StaleTopic).toBeUndefined();
    expect(doneCall[1].topic_summaries['Tech>All'].text).toBe('Fresh summary.');
  });
});
