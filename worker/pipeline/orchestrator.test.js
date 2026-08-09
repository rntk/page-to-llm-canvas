import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isSummaryCheckpointComplete, runPipeline } from './orchestrator.js';
import {
  chunkTaggedText,
  chunkTopicRangeSentences,
  groupsToTopics,
  rangesToSentenceList,
  mapTextOffsetToHtml,
} from './topicRangesStage.js';
import { parseSummaryResponse, shouldInlineRun, chunkSourceSentences } from './sourceSummarizer.js';
import { classifyLlmError } from './summaryStage.js';
import { buildTopicTree, splitContiguousRuns } from './topicTreeMerge.js';
import * as storage from '../storage/storage.js';
import * as html from './html.js';
import * as sentenceSplitter from './sentenceSplitter.js';
import * as llm from '../llm/llm.js';
import * as parserMetrics from '../metrics/parser.js';
import * as resplitMetrics from '../metrics/resplit.js';
import { getStoredVerboseLogs } from '../settings/verboseLog.js';
import { getStoredMaxParallelLlmRequests } from '../settings/llmConcurrency.js';

const pipelineLimiter = vi.hoisted(() => ({
  run: vi.fn((fn) => fn()),
  setLimit: vi.fn(),
}));

vi.mock('../storage/storage.js', () => ({
  readRecord: vi.fn(),
  updateRecord: vi.fn(),
  appendProcessingLog: vi.fn(),
  flushProcessingLog: vi.fn(),
}));

vi.mock('./html.js', () => ({
  stripTagsKeepOffsets: vi.fn(),
  // topicParser.js uses the real decodeEntities to canonicalize label
  // segments; the passthrough keeps entity-free fixture labels intact.
  decodeEntities: vi.fn((s) => s),
}));

vi.mock('./sentenceSplitter.js', () => ({
  splitSentences: vi.fn(),
}));

vi.mock('../llm/llm.js', () => ({
  callLLMWithRetry: vi.fn(),
  createAdjustableLimiter: vi.fn(() => pipelineLimiter),
  createLimiter: vi.fn(() => (fn) => fn()),
  parallelMap: vi.fn(async (items, limit, fn) => {
    const results = [];
    for (let i = 0; i < items.length; i++) {
      results.push(await fn(items[i], i));
    }
    return results;
  }),
}));

vi.mock('../metrics/parser.js', () => ({
  recordParserMetric: vi.fn(async () => undefined),
}));

vi.mock('../metrics/resplit.js', async () => {
  const actual = await vi.importActual('../metrics/resplit.js');
  return {
    ...actual,
    recordResplitRun: vi.fn(async () => undefined),
  };
});

vi.mock('../settings/verboseLog.js', () => ({
  getStoredVerboseLogs: vi.fn(async () => false),
}));

vi.mock('../settings/language.js', () => ({
  getStoredPreferContentLanguage: vi.fn(async () => false),
}));

vi.mock('../settings/llmConcurrency.js', () => ({
  DEFAULT_MAX_PARALLEL_LLM_REQUESTS: 4,
  MAX_PARALLEL_LLM_REQUESTS_KEY: 'pagetollm-max-parallel-llm-requests',
  getStoredMaxParallelLlmRequests: vi.fn(async () => 4),
  normalizeMaxParallelLlmRequests: vi.fn((value) => Number(value) || 4),
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

const LONG_SUMMARY_TEXT =
  'Acme reported revenue growth across three regions while executives said supply costs eased, customer renewals improved, new enterprise contracts expanded, hiring remained selective, product upgrades should support margins through the next fiscal quarter, and overseas demand is recovering steadily.';

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
  storage.flushProcessingLog.mockResolvedValue(undefined);
  html.stripTagsKeepOffsets.mockReturnValue({ text: '', mapping: [0] });
  sentenceSplitter.splitSentences.mockReturnValue([]);
  llm.callLLMWithRetry.mockResolvedValue('');
});

describe('isSummaryCheckpointComplete', () => {
  it('requires every topic reference to be an in-range integer sentence id', () => {
    const record = {
      sentences: ['One.', 'Two.'],
      topics: [{ name: 'A', sentences: [1, 2] }],
    };

    expect(isSummaryCheckpointComplete(record)).toBe(true);
    for (const invalidSentenceId of [0, 3, 1.5, '1']) {
      expect(
        isSummaryCheckpointComplete({
          ...record,
          topics: [{ name: 'A', sentences: [invalidSentenceId] }],
        }),
      ).toBe(false);
    }
  });

  it('rejects a checkpoint whose topics can only produce blank summaries', () => {
    // In-range ids are not enough: each of these resumes to a record that
    // finalizes as DONE with nothing in it, and with the "Generate summaries"
    // affordance switched off because summariesIncomplete stays false.
    expect(
      isSummaryCheckpointComplete({
        sentences: ['One.', 'Two.'],
        topics: [{ name: 'A', sentences: [] }],
      }),
    ).toBe(false);
    expect(
      isSummaryCheckpointComplete({
        sentences: ['   ', ''],
        topics: [{ name: 'A', sentences: [1, 2] }],
      }),
    ).toBe(false);
    expect(
      isSummaryCheckpointComplete({
        sentences: ['One.', 'Two.'],
        topics: [{ name: 'A', sentences: [1] }, { sentences: [2] }],
      }),
    ).toBe(false);
    for (const unusableName of ['', '   ', 42, null]) {
      expect(
        isSummaryCheckpointComplete({
          sentences: ['One.', 'Two.'],
          topics: [{ name: unusableName, sentences: [1, 2] }],
        }),
      ).toBe(false);
    }
    expect(
      isSummaryCheckpointComplete({
        sentences: ['One.', 'Two.'],
        topics: [{ name: 'A', sentences: 'nope' }],
      }),
    ).toBe(false);
  });

  it('accepts a checkpoint where one topic is empty but others still summarize', () => {
    // A fresh run could produce the same empty topic, so refusing the whole
    // checkpoint would only throw away the summaries that did survive.
    expect(
      isSummaryCheckpointComplete({
        sentences: ['One.', 'Two.'],
        topics: [
          { name: 'A', sentences: [1, 2] },
          { name: 'B', sentences: [] },
        ],
      }),
    ).toBe(true);
  });
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

describe('chunkTopicRangeSentences', () => {
  it('restarts local markers and preserves each global start offset', () => {
    const chunks = chunkTopicRangeSentences(['A', 'B', 'C', 'D', 'E'], 100, 2);
    expect(chunks).toEqual([
      { start: 0, sentenceCount: 2, tagged: '{0} A\n{1} B' },
      { start: 2, sentenceCount: 2, tagged: '{0} C\n{1} D' },
      { start: 4, sentenceCount: 1, tagged: '{0} E' },
    ]);
  });

  it('also bounds chunks by characters without dropping an oversized sentence', () => {
    const chunks = chunkTopicRangeSentences(['12345', '67890', 'x'.repeat(30)], 15, 10);
    expect(chunks.map((chunk) => chunk.sentenceCount)).toEqual([1, 1, 1]);
    expect(chunks.map((chunk) => chunk.start)).toEqual([0, 1, 2]);
  });
});

// ---------------------------------------------------------------------------
// chunkSourceSentences
// ---------------------------------------------------------------------------

describe('chunkSourceSentences', () => {
  // sentenceTexts is 0-based; ids are global 1-based indices into it.
  const sentenceTexts = ['aaaa', 'bbbb', 'cccc', 'dddd'];

  it('keeps all sentences in one chunk when they fit the budget', () => {
    const chunks = chunkSourceSentences([1, 2, 3, 4], sentenceTexts, 1000);
    expect(chunks).toEqual([{ start: 1, end: 4, text: 'aaaa bbbb cccc dddd' }]);
  });

  it('splits at sentence boundaries and tracks each chunk start/end id', () => {
    // Budget 10: "aaaa"(5) + "bbbb"(5) = 10 fits; adding "cccc" overflows.
    const chunks = chunkSourceSentences([1, 2, 3, 4], sentenceTexts, 10);
    expect(chunks).toEqual([
      { start: 1, end: 2, text: 'aaaa bbbb' },
      { start: 3, end: 4, text: 'cccc dddd' },
    ]);
  });

  it('emits a single oversized sentence as its own chunk rather than dropping it', () => {
    const texts = ['short', 'x'.repeat(50), 'tail'];
    const chunks = chunkSourceSentences([1, 2, 3], texts, 10);
    expect(chunks).toEqual([
      { start: 1, end: 1, text: 'short' },
      { start: 2, end: 2, text: 'x'.repeat(50) },
      { start: 3, end: 3, text: 'tail' },
    ]);
  });

  it('skips ids with no backing sentence text', () => {
    const chunks = chunkSourceSentences([1, 9, 2], sentenceTexts, 1000);
    expect(chunks).toEqual([{ start: 1, end: 2, text: 'aaaa bbbb' }]);
  });
});

// ---------------------------------------------------------------------------
// splitContiguousRuns
// ---------------------------------------------------------------------------

describe('splitContiguousRuns', () => {
  it('splits non-adjacent sentence ids into one run per occurrence', () => {
    expect(splitContiguousRuns([1, 2, 5, 6, 10])).toEqual([[1, 2], [5, 6], [10]]);
  });

  it('sorts ids before grouping', () => {
    expect(splitContiguousRuns([6, 1, 5, 2])).toEqual([
      [1, 2],
      [5, 6],
    ]);
  });

  it('deduplicates ids before grouping', () => {
    expect(splitContiguousRuns([2, 1, 1, 2, 5, 5])).toEqual([[1, 2], [5]]);
  });

  it('returns a single run for fully contiguous ids', () => {
    expect(splitContiguousRuns([1, 2, 3])).toEqual([[1, 2, 3]]);
  });

  it('handles empty input', () => {
    expect(splitContiguousRuns([])).toEqual([]);
    expect(splitContiguousRuns(undefined)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// shouldInlineRun
// ---------------------------------------------------------------------------

describe('shouldInlineRun', () => {
  it('inlines short runs so their source facts can feed parent merges', () => {
    expect(shouldInlineRun([1, 2], 'AI chip launched. It costs $5.')).toBe(true);
  });

  it('keeps longer runs on the LLM summary path', () => {
    expect(shouldInlineRun([1], LONG_SUMMARY_TEXT)).toBe(false);
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
// groupsToTopics
// ---------------------------------------------------------------------------

describe('groupsToTopics', () => {
  it('converts parsed groups into stored topic records with HTML offsets', () => {
    const sentenceObjs = [
      { text: 'AB.', start: 0, end: 3 },
      { text: 'CD.', start: 4, end: 7 },
      { text: 'EF.', start: 8, end: 11 },
    ];
    const mapping = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110];
    const topics = groupsToTopics(
      [{ label: ['Tech', 'AI'], ranges: [{ start: 0, end: 1 }] }],
      sentenceObjs,
      mapping,
    );

    expect(topics).toEqual([
      {
        name: 'Tech>AI',
        sentences: [1, 2],
        sentence_spans: [
          { sentence: 1, start: 0, end: 30 },
          { sentence: 2, start: 40, end: 70 },
        ],
        ranges: [{ sentence_start: 1, sentence_end: 2, start: 0, end: 70 }],
      },
    ]);
  });

  it('deduplicates overlapping sentence ranges while preserving range records', () => {
    const sentenceObjs = [
      { text: 'A.', start: 0, end: 2 },
      { text: 'B.', start: 3, end: 5 },
      { text: 'C.', start: 6, end: 8 },
    ];
    const topics = groupsToTopics(
      [
        {
          label: ['Overlap'],
          ranges: [
            { start: 0, end: 1 },
            { start: 1, end: 2 },
          ],
        },
      ],
      sentenceObjs,
      makeMapping('A. B. C.'),
    );

    expect(topics[0].sentences).toEqual([1, 2, 3]);
    expect(topics[0].sentence_spans.map((span) => span.sentence)).toEqual([1, 2, 3]);
    expect(topics[0].ranges).toHaveLength(2);
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
  it('configures the shared LLM limiter from the stored setting', async () => {
    getStoredMaxParallelLlmRequests.mockResolvedValueOnce(2);
    storage.readRecord.mockResolvedValue(makeRecord('limited', '<p></p>'));

    await runPipeline('limited');

    expect(pipelineLimiter.setLimit).toHaveBeenCalledWith(2);
  });

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
      if (prompt.includes('Summarize the text within the <text> tags')) return 'Summary text.';
      return '';
    });

    await runPipeline('key1');

    const doneCall = storage.updateRecord.mock.calls.find((call) => call[1].status === 'done');
    expect(doneCall).toBeDefined();
    const final = doneCall[1];
    expect(final.topic_summaries['Tech>All'].runs[0].text).toBe(plainText);
    expect(final.topic_summary_index['Tech>All'].runs[0].text).toBe(plainText);
    expect(
      llm.callLLMWithRetry.mock.calls.some(([opts]) =>
        opts.prompt.includes('Summarize the text within the <text> tags'),
      ),
    ).toBe(false);

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
      expect.anything(),
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
      if (prompt.includes('Summarize the text within the <text> tags')) return 'Summary.';
      return '';
    });

    await runPipeline('key3');
    expect(attempt).toBe(2);

    const lastCall = storage.updateRecord.mock.calls[storage.updateRecord.mock.calls.length - 1];
    expect(lastCall[1].status).toBe('done');
  });

  it('emits topic_ranges_parse_diagnostics and raw_response on a failed parse attempt', async () => {
    getStoredVerboseLogs.mockResolvedValue(true);
    const plainText = 'A. B. C.';
    const mapping = makeMapping(plainText);
    storage.readRecord.mockResolvedValue(makeRecord('key3-verbose', '<p>A. B. C.</p>'));
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
      if (prompt.includes('Summarize the text within the <text> tags')) return 'Summary.';
      return '';
    });

    await runPipeline('key3-verbose');
    expect(attempt).toBe(2);

    const entries = storage.appendProcessingLog.mock.calls.map((call) => ({
      stage: call[1],
      details: call[2],
    }));
    const failedDiag = entries.find(
      (e) => e.stage === 'topic_ranges_parse_diagnostics' && e.details.attempt === 1,
    );
    const failedRaw = entries.find(
      (e) => e.stage === 'topic_ranges_raw_response' && e.details.attempt === 1,
    );
    expect(failedDiag).toBeDefined();
    expect(failedRaw).toBeDefined();
    expect(failedRaw.details.response).toBe('Invalid response');
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
      expect.anything(),
    );
  });

  it('persists an unrelated error that settles after the signal is aborted', async () => {
    const controller = new AbortController();
    storage.readRecord.mockResolvedValue(makeRecord('cancelled-plain-error', '<p>text</p>'));
    html.stripTagsKeepOffsets.mockImplementation(() => {
      controller.abort();
      throw new Error('transport closed while aborting');
    });

    await expect(
      runPipeline('cancelled-plain-error', { signal: controller.signal }),
    ).rejects.toThrow('transport closed while aborting');

    expect(
      storage.updateRecord.mock.calls.some(
        ([key, patch]) => key === 'cancelled-plain-error' && patch.status === 'error',
      ),
    ).toBe(true);
  });

  function loggedStages() {
    return storage.appendProcessingLog.mock.calls.map((call) => call[1]);
  }

  it('skips verbose processing-log stages when the setting is off', async () => {
    getStoredVerboseLogs.mockResolvedValue(false);
    const plainText = 'Sentence one. Sentence two.';
    const mapping = makeMapping(plainText);

    storage.readRecord.mockResolvedValue(
      makeRecord('key-quiet', '<p>Sentence one. Sentence two.</p>'),
    );
    html.stripTagsKeepOffsets.mockReturnValue({ text: plainText, mapping });
    sentenceSplitter.splitSentences.mockReturnValue([
      { text: 'Sentence one.', start: 0, end: 13 },
      { text: 'Sentence two.', start: 14, end: 27 },
    ]);
    llm.callLLMWithRetry.mockImplementation(async ({ prompt }) => {
      if (prompt.includes('Partition the markers')) return 'Tech>All: 0-1';
      if (prompt.includes('Summarize the text within the <text> tags')) return 'Summary text.';
      return '';
    });

    await runPipeline('key-quiet');

    const stages = loggedStages();
    expect(stages).toContain('pipeline_start');
    expect(stages).toContain('pipeline_done');
    expect(stages).not.toContain('cleaning_html_start');
    expect(stages).not.toContain('topic_ranges_llm_request');
    expect(stages).not.toContain('topic_summary_llm_request');
    expect(stages).not.toContain('topic_tree_merge_start');
  });

  it('records verbose processing-log stages when the setting is on', async () => {
    getStoredVerboseLogs.mockResolvedValue(true);
    const plainText = 'Sentence one. Sentence two.';
    const mapping = makeMapping(plainText);

    storage.readRecord.mockResolvedValue(
      makeRecord('key-verbose', '<p>Sentence one. Sentence two.</p>'),
    );
    html.stripTagsKeepOffsets.mockReturnValue({ text: plainText, mapping });
    sentenceSplitter.splitSentences.mockReturnValue([
      { text: 'Sentence one.', start: 0, end: 13 },
      { text: 'Sentence two.', start: 14, end: 27 },
    ]);
    llm.callLLMWithRetry.mockImplementation(async ({ prompt }) => {
      if (prompt.includes('Partition the markers')) return 'Tech>All: 0-1';
      if (prompt.includes('Summarize the text within the <text> tags')) return 'Summary text.';
      return '';
    });

    await runPipeline('key-verbose');

    const stages = loggedStages();
    expect(stages).toContain('pipeline_start');
    expect(stages).toContain('cleaning_html_start');
    expect(stages).toContain('topic_ranges_llm_request');
    expect(stages).toContain('topic_summary_llm_request');
    expect(stages).toContain('topic_tree_merge_start');
    expect(stages).toContain('pipeline_done');
  });

  function loggedEntries() {
    return storage.appendProcessingLog.mock.calls.map((call) => ({
      stage: call[1],
      details: call[2],
    }));
  }

  it('does not emit topic_ranges_parse_diagnostics/raw_response for a clean parse', async () => {
    getStoredVerboseLogs.mockResolvedValue(true);
    const plainText = 'Sentence one. Sentence two.';
    const mapping = makeMapping(plainText);

    storage.readRecord.mockResolvedValue(
      makeRecord('key-verbose-clean', '<p>Sentence one. Sentence two.</p>'),
    );
    html.stripTagsKeepOffsets.mockReturnValue({ text: plainText, mapping });
    sentenceSplitter.splitSentences.mockReturnValue([
      { text: 'Sentence one.', start: 0, end: 13 },
      { text: 'Sentence two.', start: 14, end: 27 },
    ]);
    llm.callLLMWithRetry.mockImplementation(async ({ prompt }) => {
      if (prompt.includes('Partition the markers')) return 'Tech>All: 0-1';
      if (prompt.includes('Summarize the text within the <text> tags')) return 'Summary text.';
      return '';
    });

    await runPipeline('key-verbose-clean');

    const stages = loggedStages();
    expect(stages).not.toContain('topic_ranges_parse_diagnostics');
    expect(stages).not.toContain('topic_ranges_raw_response');
  });

  it('emits topic_ranges_parse_diagnostics and topic_ranges_raw_response when the parse has quirks', async () => {
    getStoredVerboseLogs.mockResolvedValue(true);
    const plainText = 'Sentence one. Sentence two.';
    const mapping = makeMapping(plainText);

    storage.readRecord.mockResolvedValue(
      makeRecord('key-verbose-quirky', '<p>Sentence one. Sentence two.</p>'),
    );
    html.stripTagsKeepOffsets.mockReturnValue({ text: plainText, mapping });
    sentenceSplitter.splitSentences.mockReturnValue([
      { text: 'Sentence one.', start: 0, end: 13 },
      { text: 'Sentence two.', start: 14, end: 27 },
    ]);
    // Only sentence 0 is claimed; sentence 1 is a trailing gap the repair
    // step fills, which should surface as a diagnostics quirk.
    llm.callLLMWithRetry.mockImplementation(async ({ prompt }) => {
      if (prompt.includes('Partition the markers')) return 'Tech>All: 0';
      if (prompt.includes('Summarize the text within the <text> tags')) return 'Summary text.';
      return '';
    });

    await runPipeline('key-verbose-quirky');

    const entries = loggedEntries();
    const diagEntry = entries.find((e) => e.stage === 'topic_ranges_parse_diagnostics');
    const rawEntry = entries.find((e) => e.stage === 'topic_ranges_raw_response');
    expect(diagEntry).toBeDefined();
    expect(diagEntry.details).toMatchObject({
      scope: 'primary',
      attempt: 1,
      sentenceCount: 2,
      missing: ['1'],
      repairsTruncated: false,
    });
    expect(diagEntry.details.repairs).toEqual([{ type: 'gap-tail', filledStart: 1, filledEnd: 1 }]);
    expect(rawEntry).toBeDefined();
    expect(rawEntry.details).toMatchObject({
      scope: 'primary',
      attempt: 1,
      response: 'Tech>All: 0',
      responseLength: 'Tech>All: 0'.length,
      truncated: false,
    });
  });

  it.each([
    ['invalid range token', 'Tech>All: 0-1, nope', { invalidRangeTokens: 1 }],
    ['out-of-range indices', 'Tech>All: 0-3', { outOfRange: [[0, 3]] }],
    ['duplicate indices', 'Tech>A: 0-1\nTech>B: 1', { duplicates: ['1'] }],
    ['reversed range', 'Tech>All: 1-0', { reversedRanges: 1 }],
    ['ignored output line', 'Tech>All: 0-1\nunstructured commentary', { ignoredLineCount: 1 }],
  ])('surfaces %s as a diagnostic quirk on its own', async (_label, response, expected) => {
    getStoredVerboseLogs.mockResolvedValue(true);
    const plainText = 'Sentence one. Sentence two.';
    storage.readRecord.mockResolvedValue(
      makeRecord(`key-verbose-${_label}`, '<p>Sentence one. Sentence two.</p>'),
    );
    html.stripTagsKeepOffsets.mockReturnValue({ text: plainText, mapping: makeMapping(plainText) });
    sentenceSplitter.splitSentences.mockReturnValue([
      { text: 'Sentence one.', start: 0, end: 13 },
      { text: 'Sentence two.', start: 14, end: 27 },
    ]);
    llm.callLLMWithRetry.mockImplementation(async ({ prompt }) => {
      if (prompt.includes('Partition the markers')) return response;
      if (prompt.includes('Summarize the text within the <text> tags')) return 'Summary text.';
      return '';
    });

    await runPipeline(`key-verbose-${_label}`);

    const entries = loggedEntries();
    const diagEntry = entries.find((entry) => entry.stage === 'topic_ranges_parse_diagnostics');
    expect(diagEntry).toBeDefined();
    expect(diagEntry.details).toMatchObject({ scope: 'primary', attempt: 1, ...expected });
    expect(
      entries.find((entry) => entry.stage === 'topic_ranges_raw_response')?.details.response,
    ).toBe(response);
  });

  it('summarizes a parent topic from its own source text, not by merging child summaries', async () => {
    const plainText = 'AI chip launched. It costs $5. Robot ships Tuesday. It weighs 2kg.';
    const mapping = makeMapping(plainText);
    storage.readRecord.mockResolvedValue(makeRecord('key5', `<p>${plainText}</p>`));
    html.stripTagsKeepOffsets.mockReturnValue({ text: plainText, mapping });
    sentenceSplitter.splitSentences.mockReturnValue([
      { text: 'AI chip launched.', start: 0, end: 17 },
      { text: 'It costs $5.', start: 18, end: 30 },
      { text: 'Robot ships Tuesday.', start: 31, end: 52 },
      { text: 'It weighs 2kg.', start: 53, end: 67 },
    ]);

    let sourcePrompt = '';
    const parentSummary = 'AI chip and robot news.\n- AI chip costs $5\n- Robot weighs 2kg';
    llm.callLLMWithRetry.mockImplementation(async ({ prompt }) => {
      if (prompt.includes('Partition the markers')) {
        return 'Tech>AI: 0-1\nTech>Hardware: 2-3';
      }
      // The parent topic is summarized from its full source text.
      if (prompt.includes('Summarize the source text')) {
        sourcePrompt = prompt;
        return parentSummary;
      }
      // Leaf per-topic summaries.
      return 'Leaf summary.';
    });

    await runPipeline('key5');

    const lastCall = storage.updateRecord.mock.calls[storage.updateRecord.mock.calls.length - 1];
    expect(lastCall[1].status).toBe('done');
    expect(lastCall[1].topic_summary_index).toBeDefined();
    expect(lastCall[1].topic_summary_index['Tech'].runs[0].text).toBe(parentSummary);
    // The parent summary is generated from the full source text of both
    // children, not from their brief leaf summaries.
    expect(sourcePrompt).toContain('AI chip launched. It costs $5.');
    expect(sourcePrompt).toContain('Robot ships Tuesday. It weighs 2kg.');
    expect(sourcePrompt).not.toContain('Leaf summary.');
    // The source fits the budget, so no chunk-merge call is made.
    expect(
      llm.callLLMWithRetry.mock.calls.some(([opts]) =>
        opts.prompt.includes('Merge the summaries below'),
      ),
    ).toBe(false);
  });

  it('parks for review with a helpful error when a topic summary keeps failing', async () => {
    const plainText = LONG_SUMMARY_TEXT;
    const mapping = makeMapping(plainText);
    storage.readRecord.mockResolvedValue(makeRecord('key6', `<p>${plainText}</p>`));
    html.stripTagsKeepOffsets.mockReturnValue({ text: plainText, mapping });
    sentenceSplitter.splitSentences.mockReturnValue([
      { text: plainText, start: 0, end: plainText.length },
    ]);

    llm.callLLMWithRetry.mockImplementation(async ({ prompt }) => {
      if (prompt.includes('Partition the markers')) return 'Tech>All: 0';
      if (prompt.includes('Summarize the text within the <text> tags')) {
        throw new Error('LLM request timed out after 120000ms');
      }
      return '';
    });

    await runPipeline('key6');

    // No 'done' write: the run parks awaiting a user decision instead of
    // silently finishing the failed topic empty.
    expect(storage.updateRecord.mock.calls.some((c) => c[1].status === 'done')).toBe(false);

    const parkCall = storage.updateRecord.mock.calls.find((c) => c[1].status === 'needs_attention');
    expect(parkCall).toBeDefined();
    expect(parkCall[1].summaryErrors).toHaveLength(1);
    expect(parkCall[1].summaryErrors[0].topic).toBe('Tech>All');
    expect(parkCall[1].summaryErrors[0].error_kind).toBe('timeout');
    expect(parkCall[1].summaryErrors[0].error_message).toMatch(/did not respond/i);
  });

  it('persists the original provider failure when it settles after abort', async () => {
    const controller = new AbortController();
    const providerError = new Error('provider failed while cancellation raced');
    const plainText = LONG_SUMMARY_TEXT;
    storage.readRecord.mockResolvedValue(makeRecord('provider-abort-race', `<p>${plainText}</p>`));
    html.stripTagsKeepOffsets.mockReturnValue({ text: plainText, mapping: makeMapping(plainText) });
    sentenceSplitter.splitSentences.mockReturnValue([
      { text: plainText, start: 0, end: plainText.length },
    ]);
    llm.callLLMWithRetry.mockImplementation(async ({ prompt }) => {
      if (prompt.includes('Partition the markers')) return 'Tech>All: 0';
      if (prompt.includes('Summarize the text within the <text> tags')) {
        controller.abort();
        throw providerError;
      }
      return '';
    });

    await expect(runPipeline('provider-abort-race', { signal: controller.signal })).rejects.toBe(
      providerError,
    );

    expect(
      storage.updateRecord.mock.calls.some(
        ([key, patch]) =>
          key === 'provider-abort-race' &&
          patch.status === 'error' &&
          patch.error.includes(providerError.message),
      ),
    ).toBe(true);
    expect(
      storage.updateRecord.mock.calls.some(([, patch]) => patch.status === 'needs_attention'),
    ).toBe(false);
  });

  it('uses source text when the summary model returns NO_SUMMARY', async () => {
    const plainText = LONG_SUMMARY_TEXT;
    storage.readRecord.mockResolvedValue(makeRecord('nosummary', `<p>${plainText}</p>`));
    html.stripTagsKeepOffsets.mockReturnValue({
      text: plainText,
      mapping: makeMapping(plainText),
    });
    sentenceSplitter.splitSentences.mockReturnValue([
      { text: plainText, start: 0, end: plainText.length },
    ]);

    llm.callLLMWithRetry.mockImplementation(async ({ prompt }) => {
      if (prompt.includes('Partition the markers')) return 'Tech>All: 0';
      if (prompt.includes('Summarize the text within the <text> tags')) return 'NO_SUMMARY';
      return '';
    });

    await runPipeline('nosummary');

    const doneCall = storage.updateRecord.mock.calls.find((call) => call[1].status === 'done');
    expect(doneCall[1].topic_summaries['Tech>All'].runs[0].text).toBe(plainText);
    expect(doneCall[1].topic_summary_index['Tech>All'].runs[0].text).toBe(plainText);
  });

  it('chunks primary topic input into bounded sentence windows', async () => {
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
        const markerIds = [...prompt.matchAll(/^\{(\d+)\}/gm)].map((match) => Number(match[1]));
        const last = Math.max(...markerIds);
        const ranges = [];
        for (let start = 0; start <= last; start += 40) {
          ranges.push(`Tech>Chunk ${chunkCount}-${start}: ${start}-${Math.min(last, start + 39)}`);
        }
        return ranges.join('\n');
      }
      if (prompt.includes('Summarize the text within the <text> tags')) return 'Summary.';
      return '';
    });

    await runPipeline('key7');
    expect(chunkCount).toBeGreaterThan(1);
    expect(storage.updateRecord).toHaveBeenCalledWith(
      'key7',
      expect.objectContaining({ status: 'done' }),
      expect.anything(),
    );
  });

  it('parses each primary chunk locally and restores global sentence offsets', async () => {
    const n = 245;
    const plainText = Array.from({ length: n }, (_, i) => `S${i}.`).join(' ');
    storage.readRecord.mockResolvedValue(makeRecord('key-local-chunks', `<p>${plainText}</p>`));
    html.stripTagsKeepOffsets.mockReturnValue({ text: plainText, mapping: makeMapping(plainText) });
    sentenceSplitter.splitSentences.mockReturnValue(
      Array.from({ length: n }, (_, i) => ({ text: `S${i}.`, start: i * 5, end: i * 5 + 3 })),
    );

    let partitionCalls = 0;
    llm.callLLMWithRetry.mockImplementation(async ({ prompt }) => {
      if (prompt.includes('Partition the markers')) {
        partitionCalls++;
        if (prompt.includes('{239}')) {
          return [
            'Tech>Part 1: 0-39',
            'Tech>Part 2: 40-79',
            'Tech>Part 3: 80-119',
            'Tech>Part 4: 120-159',
            'Tech>Part 5: 160-199',
            'Tech>Part 6: 200-239',
          ].join('\n');
        }
        return 'Tech>Last: 0-4';
      }
      if (prompt.includes('Summarize the text within the <text> tags')) return 'Summary.';
      return '';
    });

    await runPipeline('key-local-chunks');

    expect(partitionCalls).toBe(2);
    const topicCall = storage.updateRecord.mock.calls.find(
      (call) => call[1].topics && call[1].status === 'summarizing',
    );
    expect(topicCall[1].topics.map((topic) => topic.name)).toEqual([
      'Tech>Part 1',
      'Tech>Part 2',
      'Tech>Part 3',
      'Tech>Part 4',
      'Tech>Part 5',
      'Tech>Part 6',
      'Tech>Last',
    ]);
    expect(topicCall[1].topics[6].sentences).toEqual([241, 242, 243, 244, 245]);
  });

  it('records successful chunk metrics only after the full parse attempt succeeds', async () => {
    const n = 241;
    const plainText = Array.from({ length: n }, (_, i) => `S${i}.`).join(' ');
    storage.readRecord.mockResolvedValue(makeRecord('key-metric-retry', `<p>${plainText}</p>`));
    html.stripTagsKeepOffsets.mockReturnValue({ text: plainText, mapping: makeMapping(plainText) });
    sentenceSplitter.splitSentences.mockReturnValue(
      Array.from({ length: n }, (_, i) => ({ text: `S${i}.`, start: i * 5, end: i * 5 + 3 })),
    );

    let shortChunkCalls = 0;
    llm.callLLMWithRetry.mockImplementation(async ({ prompt }) => {
      if (prompt.includes('Partition the markers')) {
        if (prompt.includes('{239}')) {
          return Array.from({ length: 6 }, (_, i) => {
            const start = i * 40;
            return `Tech>Part ${i + 1}: ${start}-${start + 39}`;
          }).join('\n');
        }
        shortChunkCalls++;
        return shortChunkCalls === 1 ? 'not parseable' : 'Tech>Last: 0';
      }
      if (prompt.includes('Summarize the text within the <text> tags')) return 'Summary.';
      return '';
    });

    await runPipeline('key-metric-retry');

    const primarySamples = parserMetrics.recordParserMetric.mock.calls
      .map(([sample]) => sample)
      .filter((sample) => sample.scope === 'primary');
    expect(primarySamples.map((sample) => sample.ok)).toEqual([false, true, true]);
    expect(primarySamples.filter((sample) => sample.recoveredAfterRetry)).toHaveLength(1);
    expect(primarySamples.at(-1).recoveredAfterRetry).toBe(true);
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
      if (prompt.includes('Summarize the text within the <text> tags')) return 'Summary.';
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

    // A resplit metrics sample is recorded exactly once per refineOversizedRanges
    // call, reflecting that this run found (and successfully split) one
    // oversized 60-sentence range.
    expect(resplitMetrics.recordResplitRun).toHaveBeenCalledTimes(1);
    const sample = resplitMetrics.recordResplitRun.mock.calls[0][0];
    expect(sample).toMatchObject({
      oversizeCount: 1,
      oversizeSpans: [60],
      changed: true,
      groupCountBefore: 1,
      groupCountAfter: 2,
    });
    expect(sample.resplitCallCount).toBeGreaterThan(0);
    expect(sample.outcomes.subdivided).toBe(1);
    // llmRequestCount counts actual LLM requests (one per chunk), which is
    // always >= resplitCallCount (one per resplitSegment invocation); this
    // fixture's tagged text stays under MAX_TAGGED_CHARS so no invocation
    // fans out into multiple chunk requests, and the two stay equal here.
    expect(sample.llmRequestCount).toBeGreaterThanOrEqual(sample.resplitCallCount);
    // 60 sentences stays under both MAX_TAGGED_CHARS and
    // TOPIC_RANGE_INPUT_MAX_SENTENCES (240), so the primary stage used a
    // single chunk/request for this fixture.
    expect(sample.primaryChunkCount).toBe(1);
  });

  it('falls back to bounded windows when a re-split makes no progress', async () => {
    // The first re-split insists the slice is still a single topic. The stage
    // then queries two <=40-sentence windows before accepting that answer.
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
      if (prompt.includes('Summarize the text within the <text> tags')) return 'Summary.';
      return '';
    });

    await runPipeline('keyBig2');

    // Primary partition + failed whole-range re-split + two bounded windows.
    expect(partitionCalls).toBe(4);
    const topicCall = storage.updateRecord.mock.calls.find(
      (call) => call[1].topics && call[1].status === 'summarizing',
    );
    expect(topicCall[1].topics.map((t) => t.name)).toEqual(['Tech>All']);
    const doneCall = storage.updateRecord.mock.calls.find((call) => call[1].status === 'done');
    expect(doneCall).toBeDefined();

    // Still recorded even though the resplit made no progress: the sample is
    // the denominator, not a success flag.
    expect(resplitMetrics.recordResplitRun).toHaveBeenCalledTimes(1);
    const sample = resplitMetrics.recordResplitRun.mock.calls[0][0];
    // The window fallback does split the segment (2 windows), so `changed`
    // is true even though groupsFromSegments recombines them back into a
    // single "Tech>All" group (both windows carry the same label).
    expect(sample).toMatchObject({
      oversizeCount: 1,
      oversizeSpans: [60],
      changed: true,
      groupCountBefore: 1,
      groupCountAfter: 1,
      resplitCallCount: 3,
      primaryChunkCount: 1,
    });
    // This is exactly the "changed but no net group gain" case
    // runsWithGroupGain exists to filter out: groupCountAfter does not
    // exceed groupCountBefore, so this run would NOT count toward
    // runsWithGroupGain even though it does count toward runsChanged.
    expect(sample.groupCountAfter).not.toBeGreaterThan(sample.groupCountBefore);
    expect(sample.outcomes).toMatchObject({
      windowFallback: 1,
      acceptedSingle: 2,
      subdivided: 0,
      noProgress: 0,
      error: 0,
    });
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
      if (prompt.includes('Summarize the text within the <text> tags')) return 'Summary.';
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
      if (prompt.includes('Summarize the text within the <text> tags')) return 'Summary.';
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
      if (prompt.includes('Summarize the text within the <text> tags')) return 'Summary.';
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
      sentences: ['Alpha.', LONG_SUMMARY_TEXT],
      topics: [
        { name: 'A', sentences: [1], sentence_spans: [], ranges: [] },
        { name: 'B', sentences: [2], sentence_spans: [], ranges: [] },
      ],
      topic_summaries: {
        A: { runs: [{ sentences: [1], text: 'Existing A summary.' }], source_sentences: [1] },
      },
      topic_summary_index: {},
    });

    const summaryPrompts = [];
    llm.callLLMWithRetry.mockImplementation(async ({ prompt }) => {
      if (prompt.includes('Partition the markers')) return 'SHOULD_NOT_BE_CALLED: 0-1';
      if (prompt.includes('Summarize the text within the <text> tags')) {
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
    expect(summaryPrompts[0]).toContain(LONG_SUMMARY_TEXT);

    const resumeCall = storage.updateRecord.mock.calls.find(
      (call) => call[1].status === 'summarizing' && call[1].summariesIncomplete === false,
    );
    expect(resumeCall).toBeDefined();

    const doneCall = storage.updateRecord.mock.calls.find((call) => call[1].status === 'done');
    expect(doneCall).toBeDefined();
    expect(doneCall[1].topic_summaries.A.runs[0].text).toBe('Existing A summary.');
    expect(doneCall[1].topic_summaries.B.runs[0].text).toBe('Fresh B summary.');
  });

  it('refuses an incomplete resume without erasing valid summary checkpoints', async () => {
    // Same shape as a normal resumable checkpoint, except `sentences` is empty.
    // The stale topics reference sentence ids that no longer resolve to any
    // text, so resuming would silently produce blank summaries.
    const plainText = 'AB. CD.';
    const mapping = makeMapping(plainText);
    storage.readRecord.mockResolvedValue({
      key: 'resumeNoSentences',
      html: '<p>AB. CD.</p>',
      status: 'summarizing',
      sentences: [],
      topics: [{ name: 'A', sentences: [1], sentence_spans: [], ranges: [] }],
      topic_summaries: {
        A: { runs: [{ sentences: [1], text: 'Keep this summary.' }], source_sentences: [1] },
      },
      topic_summary_index: {
        A: {
          runs: [{ sentences: [1], text: 'Keep this summary.' }],
          level: 0,
          source_sentences: [1],
        },
      },
    });
    html.stripTagsKeepOffsets.mockReturnValue({ text: plainText, mapping });
    sentenceSplitter.splitSentences.mockReturnValue([
      { text: 'AB.', start: 0, end: 3 },
      { text: 'CD.', start: 4, end: 7 },
    ]);
    llm.callLLMWithRetry.mockImplementation(async ({ prompt }) => {
      if (prompt.includes('Partition the markers')) return 'Tech>All: 0-1';
      if (prompt.includes('Summarize the text within the <text> tags')) return 'Summary.';
      return '';
    });

    await expect(runPipeline('resumeNoSentences')).rejects.toThrow(
      'saved sentence checkpoint is incomplete',
    );

    // Refusal may update status/error, but it must not enter computeTopics,
    // whose first write clears every topic and summary checkpoint.
    expect(html.stripTagsKeepOffsets).not.toHaveBeenCalled();
    expect(sentenceSplitter.splitSentences).not.toHaveBeenCalled();
    expect(llm.callLLMWithRetry).not.toHaveBeenCalled();
    expect(
      storage.updateRecord.mock.calls.some(([, patch]) =>
        ['topics', 'topic_summaries', 'topic_summary_index'].some((field) =>
          Object.prototype.hasOwnProperty.call(patch, field),
        ),
      ),
    ).toBe(false);
    expect(storage.updateRecord).toHaveBeenCalledWith(
      'resumeNoSentences',
      expect.objectContaining({
        status: 'error',
        error: expect.stringContaining('saved sentence checkpoint is incomplete'),
      }),
      expect.anything(),
    );

    const rejectionLog = storage.appendProcessingLog.mock.calls.find(
      (call) => call[1] === 'pipeline_resume_rejected',
    );
    expect(rejectionLog).toBeDefined();

    const resumeLog = storage.appendProcessingLog.mock.calls.find(
      (call) => call[1] === 'pipeline_resume',
    );
    expect(resumeLog).toBeUndefined();
  });

  it('refuses a resume when a topic references an out-of-range sentence id', async () => {
    const plainText = 'AB. CD.';
    const mapping = makeMapping(plainText);
    storage.readRecord.mockResolvedValue({
      key: 'resumeOutOfRange',
      html: '<p>AB. CD.</p>',
      status: 'summarizing',
      // Only one sentence persisted, but the stale topic references sentence 2.
      sentences: ['Alpha.'],
      topics: [{ name: 'A', sentences: [1, 2], sentence_spans: [], ranges: [] }],
      topic_summaries: {},
      topic_summary_index: {},
    });
    html.stripTagsKeepOffsets.mockReturnValue({ text: plainText, mapping });
    sentenceSplitter.splitSentences.mockReturnValue([
      { text: 'AB.', start: 0, end: 3 },
      { text: 'CD.', start: 4, end: 7 },
    ]);
    llm.callLLMWithRetry.mockImplementation(async ({ prompt }) => {
      if (prompt.includes('Partition the markers')) return 'Tech>All: 0-1';
      if (prompt.includes('Summarize the text within the <text> tags')) return 'Summary.';
      return '';
    });

    await expect(runPipeline('resumeOutOfRange')).rejects.toThrow(
      'saved sentence checkpoint is incomplete',
    );

    expect(html.stripTagsKeepOffsets).not.toHaveBeenCalled();
    expect(sentenceSplitter.splitSentences).not.toHaveBeenCalled();
    expect(llm.callLLMWithRetry).not.toHaveBeenCalled();
    expect(
      storage.updateRecord.mock.calls.some(([, patch]) =>
        ['topics', 'topic_summaries', 'topic_summary_index'].some((field) =>
          Object.prototype.hasOwnProperty.call(patch, field),
        ),
      ),
    ).toBe(false);
    expect(storage.updateRecord).toHaveBeenCalledWith(
      'resumeOutOfRange',
      expect.objectContaining({ status: 'error' }),
      expect.anything(),
    );

    const rejectionLog = storage.appendProcessingLog.mock.calls.find(
      (call) => call[1] === 'pipeline_resume_rejected',
    );
    expect(rejectionLog).toBeDefined();
  });

  it('summarizes each non-adjacent run of a topic separately on resume', async () => {
    // A topic that recurs at two non-adjacent places ([1,2] and [5,6]) must yield
    // one summary run per occurrence, each carrying its own location's source.
    storage.readRecord.mockResolvedValue({
      key: 'runs1',
      html: '<p>ignored on resume</p>',
      status: 'summarizing',
      sentences: ['One.', 'Two.', 'Skip three.', 'Skip four.', 'Five.', 'Six.'],
      topics: [{ name: 'A', sentences: [1, 2, 5, 6], sentence_spans: [], ranges: [] }],
      topic_summaries: {},
      topic_summary_index: {},
    });

    await runPipeline('runs1');

    // Both runs are short enough to inline verbatim, so no summary LLM call fires
    // and each run keeps its own source text and sentences.
    expect(
      llm.callLLMWithRetry.mock.calls.some(([opts]) =>
        opts.prompt.includes('Summarize the text within the <text> tags'),
      ),
    ).toBe(false);

    const doneCall = storage.updateRecord.mock.calls.find((call) => call[1].status === 'done');
    expect(doneCall[1].topic_summaries.A.runs).toEqual([
      { sentences: [1, 2], text: 'One. Two.' },
      { sentences: [5, 6], text: 'Five. Six.' },
    ]);
    expect(doneCall[1].topic_summary_index.A.runs).toEqual([
      { sentences: [1, 2], text: 'One. Two.' },
      { sentences: [5, 6], text: 'Five. Six.' },
    ]);
  });

  it('reuses each child summary for a non-adjacent top-level node instead of regenerating', async () => {
    // The headline case: "Tech" aggregates two non-adjacent occurrences, each
    // wholly one child — [1,2] is Tech>A, [10,11] is Tech>B. Neither run mixes
    // subtopics, so the parent reuses each child's leaf summary (location-specific
    // text per occurrence) and never issues a source-summary LLM call for Tech.
    const long =
      'with plenty of additional descriptive words written out here to comfortably exceed the inline summary threshold for this internal node run path so the summarizer actually issues an llm call';
    const sentences = Array.from({ length: 11 }, (_, i) => `filler ${i + 1}.`);
    sentences[0] = `ALPHA occurrence one ${long}.`;
    sentences[1] = `ALPHA occurrence continues ${long}.`;
    sentences[9] = `OMEGA occurrence one ${long}.`;
    sentences[10] = `OMEGA occurrence continues ${long}.`;

    storage.readRecord.mockResolvedValue({
      key: 'multiRunParent',
      html: '<p>ignored on resume</p>',
      status: 'summarizing',
      sentences,
      topics: [
        { name: 'Tech>A', sentences: [1, 2], sentence_spans: [], ranges: [] },
        { name: 'Tech>B', sentences: [10, 11], sentence_spans: [], ranges: [] },
      ],
      topic_summaries: {},
      topic_summary_index: {},
    });

    let sourceSummaryCalls = 0;
    llm.callLLMWithRetry.mockImplementation(async ({ prompt }) => {
      // The parent would use the source-summary prompt; under per-run delegation it
      // must never be reached for Tech.
      if (prompt.includes('Summarize the source text')) {
        sourceSummaryCalls++;
        return 'should not be used';
      }
      // Leaf per-topic summaries, keyed by which occurrence's text they carry.
      return prompt.includes('ALPHA') ? 'first occurrence summary' : 'second occurrence summary';
    });

    await runPipeline('multiRunParent');

    expect(sourceSummaryCalls).toBe(0);
    const doneCall = storage.updateRecord.mock.calls.find((call) => call[1].status === 'done');
    expect(doneCall).toBeDefined();
    expect(doneCall[1].topic_summary_index['Tech'].runs).toEqual([
      { sentences: [1, 2], text: 'first occurrence summary' },
      { sentences: [10, 11], text: 'second occurrence summary' },
    ]);
  });

  it('retries only summaries flagged with an error, keeping a stored NO_SUMMARY fallback', async () => {
    storage.readRecord.mockResolvedValue({
      key: 'resume2',
      html: '<p>ignored</p>',
      status: 'summarizing',
      sentences: ['Alpha.', 'Beta.', LONG_SUMMARY_TEXT],
      topics: [
        { name: 'A', sentences: [1], sentence_spans: [], ranges: [] },
        { name: 'B', sentences: [2], sentence_spans: [], ranges: [] },
        { name: 'C', sentences: [3], sentence_spans: [], ranges: [] },
      ],
      topic_summaries: {
        A: { runs: [{ sentences: [1], text: 'Good A.' }], source_sentences: [1] },
        // A NO_SUMMARY response is persisted as the source text, so it has a
        // valid run layout and can be distinguished from a damaged entry.
        B: { runs: [{ sentences: [2], text: 'Beta.' }], source_sentences: [2] },
        C: { runs: [{ sentences: [3], text: '' }], source_sentences: [3], error: true },
      },
      topic_summary_index: {},
    });

    const summaryPrompts = [];
    llm.callLLMWithRetry.mockImplementation(async ({ prompt }) => {
      if (prompt.includes('Summarize the text within the <text> tags')) {
        summaryPrompts.push(prompt);
        return 'Recovered C.';
      }
      return '';
    });

    await runPipeline('resume2');

    // Only the errored topic C is re-queried.
    expect(summaryPrompts).toHaveLength(1);
    expect(summaryPrompts[0]).toContain(LONG_SUMMARY_TEXT);

    const doneCall = storage.updateRecord.mock.calls.find((call) => call[1].status === 'done');
    expect(doneCall[1].topic_summaries.A.runs[0].text).toBe('Good A.');
    expect(doneCall[1].topic_summaries.B.runs).toEqual([{ sentences: [2], text: 'Beta.' }]);
    expect(doneCall[1].topic_summaries.C.runs[0].text).toBe('Recovered C.');
    expect(doneCall[1].topic_summaries.C.error).toBeUndefined();
  });

  it('flags a failed summary with error:true while summarizing, then parks instead of finishing', async () => {
    storage.readRecord.mockResolvedValue(makeRecord('failmark', `<p>${LONG_SUMMARY_TEXT}</p>`));
    html.stripTagsKeepOffsets.mockReturnValue({
      text: LONG_SUMMARY_TEXT,
      mapping: makeMapping(LONG_SUMMARY_TEXT),
    });
    sentenceSplitter.splitSentences.mockReturnValue([
      { text: LONG_SUMMARY_TEXT, start: 0, end: LONG_SUMMARY_TEXT.length },
    ]);
    llm.callLLMWithRetry.mockImplementation(async ({ prompt }) => {
      if (prompt.includes('Partition the markers')) return 'Tech>All: 0';
      if (prompt.includes('Summarize the text within the <text> tags')) throw new Error('LLM down');
      return '';
    });

    await runPipeline('failmark');

    // While summarizing, the failed leaf is persisted with the error flag (plus a
    // reason) so a recycle-resume retries it instead of reusing empty text.
    const inFlightFlagged = storage.updateRecord.mock.calls.find(
      (call) => call[1].topic_summaries && call[1].topic_summaries['Tech>All']?.error === true,
    );
    expect(inFlightFlagged).toBeDefined();
    expect(inFlightFlagged[1].topic_summaries['Tech>All'].error_message).toBeTruthy();

    // Terminal side: with the failure unresolved the run parks rather than
    // reaching 'done'. The user's retry/skip decision drives it from here.
    expect(storage.updateRecord.mock.calls.some((c) => c[1].status === 'done')).toBe(false);
    const parkCall = storage.updateRecord.mock.calls.find((c) => c[1].status === 'needs_attention');
    expect(parkCall).toBeDefined();
    expect(parkCall[1].summaryErrors.map((e) => e.topic)).toContain('Tech>All');
    expect(parkCall[1].topic_summary_index['Tech>All']).toEqual({
      runs: [{ sentences: [1], text: '' }],
      level: 1,
      source_sentences: [1],
    });
  });

  it('finalizes a parked failure to empty text when resumed with forceFinalize (skip)', async () => {
    // Simulate the "skip" resume: record is back in 'summarizing', the failed
    // leaf's error flags were already swapped for `acceptedFailure` by the
    // resolveSummaryErrors handler, and forceFinalize tells the run to finish
    // accepting the empty summary.
    storage.readRecord.mockResolvedValue({
      ...makeRecord('skip1', '<p>One. Two.</p>'),
      status: 'summarizing',
      forceFinalize: true,
      topics: [{ name: 'Tech>All', sentences: [1, 2], sentence_spans: [], ranges: [] }],
      sentences: ['One.', 'Two.'],
      topic_summaries: {
        'Tech>All': {
          runs: [{ sentences: [1, 2], text: '' }],
          source_sentences: [1, 2],
          acceptedFailure: true,
        },
      },
    });
    llm.callLLMWithRetry.mockImplementation(async ({ prompt }) => {
      if (prompt.includes('Merge the chunk summaries')) return 'Merged.';
      return '';
    });

    await runPipeline('skip1');

    const doneCall = storage.updateRecord.mock.calls.find((c) => c[1].status === 'done');
    expect(doneCall).toBeDefined();
    expect(doneCall[1].topic_summaries['Tech>All'].runs).toEqual([{ sentences: [1, 2], text: '' }]);
    expect(doneCall[1].topic_summaries['Tech>All'].error).toBeUndefined();
    // The accepted failure is finalized as `forcedEmpty` (retryable later) and
    // the transient marker is not persisted.
    expect(doneCall[1].topic_summaries['Tech>All'].forcedEmpty).toBe(true);
    expect(doneCall[1].topic_summaries['Tech>All'].acceptedFailure).toBeUndefined();
    expect(doneCall[1].summariesDisabled).toBe(false);
    expect(doneCall[1].summariesIncomplete).toBe(true);
    // Park state is cleared on finalize.
    expect(doneCall[1].summaryErrors).toEqual([]);
    expect(doneCall[1].forceFinalize).toBe(false);
    // No new summary LLM call happened — skip reuses the empty leaf as-is.
    expect(
      llm.callLLMWithRetry.mock.calls.some(([opts]) =>
        opts.prompt.includes('Summarize the text within the <text> tags'),
      ),
    ).toBe(false);
  });

  it('parks for review when a tree-merge keeps failing (merge phase)', async () => {
    const plainText = 'A. B. C. D.';
    const mapping = makeMapping(plainText);
    storage.readRecord.mockResolvedValue(makeRecord('mergefail', '<p>A. B. C. D.</p>'));
    html.stripTagsKeepOffsets.mockReturnValue({ text: plainText, mapping });
    sentenceSplitter.splitSentences.mockReturnValue([
      { text: 'A.', start: 0, end: 2 },
      { text: 'B.', start: 3, end: 5 },
      { text: 'C.', start: 6, end: 8 },
      { text: 'D.', start: 9, end: 11 },
    ]);
    llm.callLLMWithRetry.mockImplementation(async ({ prompt }) => {
      // Two sibling topics under "Tech" → the parent is summarized from source.
      if (prompt.includes('Partition the markers')) return 'Tech>AI: 0-1\nTech>Hardware: 2-3';
      if (prompt.includes('Summarize the source text')) {
        throw new Error('LLM HTTP 429: too many requests');
      }
      return 'Leaf summary.';
    });

    await runPipeline('mergefail');

    // Leaves all succeeded, so the park is triggered by the parent summary, not a leaf.
    expect(storage.updateRecord.mock.calls.some((c) => c[1].status === 'done')).toBe(false);
    const parkCall = storage.updateRecord.mock.calls.find((c) => c[1].status === 'needs_attention');
    expect(parkCall).toBeDefined();
    expect(parkCall[1].summaryErrors.map((e) => e.topic)).toContain('Tech');
    expect(parkCall[1].summaryErrors[0].error_kind).toBe('rate_limited');
    expect(parkCall[1].topic_summary_index['Tech'].runs).toEqual([
      { sentences: [1, 2, 3, 4], text: '' },
    ]);
    expect(parkCall[1].topic_summary_index['Tech>AI'].runs[0].text).toBe('A. B.');
    expect(parkCall[1].topic_summary_index['Tech>Hardware'].runs[0].text).toBe('C. D.');
  });

  it('merge-phase skip reuses the parked tree index without another merge call', async () => {
    storage.readRecord.mockResolvedValue({
      ...makeRecord('mergeskip', '<p>A. B. C. D.</p>'),
      status: 'summarizing',
      forceFinalize: true,
      acceptedMergeFailurePaths: ['Tech'],
      topics: [
        { name: 'Tech>AI', sentences: [1, 2], sentence_spans: [], ranges: [] },
        { name: 'Tech>Hardware', sentences: [3, 4], sentence_spans: [], ranges: [] },
      ],
      sentences: ['A.', 'B.', 'C.', 'D.'],
      topic_summaries: {
        'Tech>AI': { runs: [{ sentences: [1, 2], text: 'AI summary.' }], source_sentences: [1, 2] },
        'Tech>Hardware': {
          runs: [{ sentences: [3, 4], text: 'HW summary.' }],
          source_sentences: [3, 4],
        },
      },
      topic_summary_index: {
        Tech: {
          runs: [{ sentences: [1, 2, 3, 4], text: '' }],
          level: 0,
          source_sentences: [1, 2, 3, 4],
        },
        'Tech>AI': {
          runs: [{ sentences: [1, 2], text: 'AI summary.' }],
          level: 1,
          source_sentences: [1, 2],
        },
        'Tech>Hardware': {
          runs: [{ sentences: [3, 4], text: 'HW summary.' }],
          level: 1,
          source_sentences: [3, 4],
        },
      },
    });
    llm.callLLMWithRetry.mockImplementation(async ({ prompt }) => {
      if (prompt.includes('Merge the chunk summaries')) throw new Error('LLM HTTP 429');
      return '';
    });

    await runPipeline('mergeskip');

    // No re-park and no provider call: the skip reuses the complete parked
    // projection, including its accepted empty parent result.
    expect(storage.updateRecord.mock.calls.some((c) => c[1].status === 'needs_attention')).toBe(
      false,
    );
    expect(
      llm.callLLMWithRetry.mock.calls.some(([opts]) =>
        opts.prompt.includes('Merge the chunk summaries'),
      ),
    ).toBe(false);
    const doneCall = storage.updateRecord.mock.calls.find((c) => c[1].status === 'done');
    expect(doneCall).toBeDefined();
    // The failed parent remains empty exactly as parked, while its successful
    // leaf results are kept.
    expect(doneCall[1].topic_summary_index['Tech'].runs).toEqual([
      { sentences: [1, 2, 3, 4], text: '' },
    ]);
    expect(doneCall[1].topic_summaries['Tech>AI'].runs[0].text).toBe('AI summary.');
    expect(doneCall[1].summariesDisabled).toBe(false);
    expect(doneCall[1].summariesIncomplete).toBe(true);
    expect(doneCall[1].summaryErrors).toEqual([]);
    expect(doneCall[1].forceFinalize).toBe(false);
  });

  it('refuses an invalid force-finalize checkpoint without consuming its review state', async () => {
    // The checkpoint has topics but no sentences. It cannot be resumed, and a
    // full recompute here would erase both the partial summaries and the user's
    // accepted-path state before they explicitly choose Reprocess.
    storage.readRecord.mockResolvedValue({
      ...makeRecord('skipInvalid', `<p>${LONG_SUMMARY_TEXT}</p>`),
      status: 'summarizing',
      forceFinalize: true,
      acceptedMergeFailurePaths: ['Old>Accepted'],
      sentences: [],
      topics: [{ name: 'Tech>All', sentences: [1], sentence_spans: [], ranges: [] }],
      topic_summaries: {
        'Tech>All': {
          runs: [{ sentences: [1], text: 'Keep this partial summary.' }],
          source_sentences: [1],
        },
      },
    });
    html.stripTagsKeepOffsets.mockReturnValue({
      text: LONG_SUMMARY_TEXT,
      mapping: makeMapping(LONG_SUMMARY_TEXT),
    });
    sentenceSplitter.splitSentences.mockReturnValue([
      { text: LONG_SUMMARY_TEXT, start: 0, end: LONG_SUMMARY_TEXT.length },
    ]);
    llm.callLLMWithRetry.mockImplementation(async ({ prompt }) => {
      if (prompt.includes('Partition the markers')) return 'Tech>All: 0';
      if (prompt.includes('Summarize the text within the <text> tags')) throw new Error('LLM down');
      return '';
    });

    await expect(runPipeline('skipInvalid')).rejects.toThrow(
      'saved sentence checkpoint is incomplete',
    );

    expect(html.stripTagsKeepOffsets).not.toHaveBeenCalled();
    expect(sentenceSplitter.splitSentences).not.toHaveBeenCalled();
    expect(llm.callLLMWithRetry).not.toHaveBeenCalled();
    const rejectionLog = storage.appendProcessingLog.mock.calls.find(
      (call) => call[1] === 'pipeline_resume_rejected',
    );
    expect(rejectionLog).toBeDefined();
    expect(
      storage.updateRecord.mock.calls.some(([, patch]) =>
        [
          'topics',
          'topic_summaries',
          'topic_summary_index',
          'forceFinalize',
          'acceptedMergeFailurePaths',
        ].some((field) => Object.prototype.hasOwnProperty.call(patch, field)),
      ),
    ).toBe(false);
    expect(storage.updateRecord).toHaveBeenCalledWith(
      'skipInvalid',
      expect.objectContaining({ status: 'error' }),
      expect.anything(),
    );
  });

  it('resumes with forceFinalize when the checkpoint is valid', async () => {
    storage.readRecord.mockResolvedValue({
      ...makeRecord('skipValid', '<p>One.</p>'),
      status: 'summarizing',
      forceFinalize: true,
      sentences: ['One.'],
      topics: [{ name: 'Tech>All', sentences: [1], sentence_spans: [], ranges: [] }],
      topic_summaries: {},
    });
    llm.callLLMWithRetry.mockImplementation(async () => {
      throw new Error('should not be called: run resumes and inlines the single short sentence');
    });

    await runPipeline('skipValid');

    // A valid checkpoint is resumed: no HTML/sentence recompute.
    expect(html.stripTagsKeepOffsets).not.toHaveBeenCalled();
    expect(sentenceSplitter.splitSentences).not.toHaveBeenCalled();
    const resumeLog = storage.appendProcessingLog.mock.calls.find(
      (call) => call[1] === 'pipeline_resume',
    );
    expect(resumeLog).toBeDefined();

    const doneCall = storage.updateRecord.mock.calls.find((c) => c[1].status === 'done');
    expect(doneCall).toBeDefined();
    expect(storage.updateRecord.mock.calls.some((c) => c[1].status === 'needs_attention')).toBe(
      false,
    );
  });

  it('does not set forceFinalize for a fresh record, so a summary failure parks for review', async () => {
    storage.readRecord.mockResolvedValue(makeRecord('freshNoForce', `<p>${LONG_SUMMARY_TEXT}</p>`));
    html.stripTagsKeepOffsets.mockReturnValue({
      text: LONG_SUMMARY_TEXT,
      mapping: makeMapping(LONG_SUMMARY_TEXT),
    });
    sentenceSplitter.splitSentences.mockReturnValue([
      { text: LONG_SUMMARY_TEXT, start: 0, end: LONG_SUMMARY_TEXT.length },
    ]);
    llm.callLLMWithRetry.mockImplementation(async ({ prompt }) => {
      if (prompt.includes('Partition the markers')) return 'Tech>All: 0';
      if (prompt.includes('Summarize the text within the <text> tags')) throw new Error('LLM down');
      return '';
    });

    await runPipeline('freshNoForce');

    // Without forceFinalize, a summary failure parks the record for review
    // instead of finalizing empty.
    expect(storage.updateRecord.mock.calls.some((c) => c[1].status === 'done')).toBe(false);
    const parkCall = storage.updateRecord.mock.calls.find((c) => c[1].status === 'needs_attention');
    expect(parkCall).toBeDefined();
  });

  it('chunks an oversized parent source into per-chunk summaries, then merges them', async () => {
    // 200 sentences of ~400 chars => ~80k chars of source for the parent "Tech"
    // node, over SOURCE_SUMMARY_MAX_CHARS (60000). Tech has two children so it is
    // summarized from its own aggregated source (not delegated): it must split
    // into chunks, summarize each chunk from source, and merge those chunk
    // summaries — rather than summarizing the whole thing in one call. Uses the
    // resume path so the oversized source never passes through topic-ranges.
    const ids = Array.from({ length: 200 }, (_, i) => i + 1);
    const sentences = ids.map((i) => `Sentence ${i} ` + 'x'.repeat(390));
    storage.readRecord.mockResolvedValue({
      ...makeRecord('overflow', '<p>x</p>'),
      status: 'summarizing',
      topics: [
        { name: 'Tech>A', sentences: ids.slice(0, 100), sentence_spans: [], ranges: [] },
        { name: 'Tech>B', sentences: ids.slice(100), sentence_spans: [], ranges: [] },
      ],
      sentences,
      topic_summaries: {},
    });

    let sourceCalls = 0;
    let mergeCalls = 0;
    llm.callLLMWithRetry.mockImplementation(async ({ prompt }) => {
      if (prompt.includes('Summarize the source text')) {
        sourceCalls++;
        return 'Chunk summary.';
      }
      if (prompt.includes('Merge the summaries below')) {
        mergeCalls++;
        return 'Merged overflow summary.';
      }
      // Leaf per-topic summaries for Tech>A and Tech>B.
      return 'Leaf.';
    });

    await runPipeline('overflow');

    // The parent source exceeded the budget: more than one chunk was summarized,
    // then exactly one merge combined those chunk summaries.
    expect(sourceCalls).toBeGreaterThan(1);
    expect(mergeCalls).toBe(1);
    const doneCall = storage.updateRecord.mock.calls.find((c) => c[1].status === 'done');
    expect(doneCall).toBeDefined();
    expect(doneCall[1].topic_summary_index['Tech'].runs[0].text).toBe('Merged overflow summary.');
    expect(doneCall[1].topic_summary_index['Tech>A'].runs[0].text).toBe('Leaf.');
  });

  it('falls back to chunk summaries when the overflow merge returns NO_SUMMARY', async () => {
    // Same oversized-parent setup, but the merge collapses to NO_SUMMARY despite
    // the chunk summaries succeeding. Internal nodes have no NO_SUMMARY escape,
    // so the parent must not finish empty — it falls back to the chunk summaries.
    const ids = Array.from({ length: 200 }, (_, i) => i + 1);
    const sentences = ids.map((i) => `Sentence ${i} ` + 'x'.repeat(390));
    storage.readRecord.mockResolvedValue({
      ...makeRecord('overflow-nosummary', '<p>x</p>'),
      status: 'summarizing',
      topics: [
        { name: 'Tech>A', sentences: ids.slice(0, 100), sentence_spans: [], ranges: [] },
        { name: 'Tech>B', sentences: ids.slice(100), sentence_spans: [], ranges: [] },
      ],
      sentences,
      topic_summaries: {},
    });

    llm.callLLMWithRetry.mockImplementation(async ({ prompt }) => {
      if (prompt.includes('Summarize the source text')) return 'Chunk summary.';
      if (prompt.includes('Merge the summaries below')) return 'NO_SUMMARY';
      return 'Leaf.';
    });

    await runPipeline('overflow-nosummary');

    const doneCall = storage.updateRecord.mock.calls.find((c) => c[1].status === 'done');
    expect(doneCall).toBeDefined();
    const parentText = doneCall[1].topic_summary_index['Tech'].runs[0].text;
    expect(parentText).not.toBe('');
    expect(parentText).toContain('Chunk summary.');
  });

  it('falls back to source text when the single-call parent summary returns NO_SUMMARY', async () => {
    // A parent whose source fits in one request: the source prompt offers no
    // NO_SUMMARY escape, but a stray NO_SUMMARY reply must not finish the run
    // with a silently empty internal topic — it falls back to the source text.
    storage.readRecord.mockResolvedValue({
      ...makeRecord('parent-nosummary', '<p>x</p>'),
      status: 'summarizing',
      topics: [
        { name: 'Tech>A', sentences: [1], sentence_spans: [], ranges: [] },
        { name: 'Tech>B', sentences: [2], sentence_spans: [], ranges: [] },
      ],
      // Each sentence is long enough that the parent's combined run exceeds the
      // inline thresholds, forcing the single-call source-summary path (where the
      // NO_SUMMARY fallback under test lives) instead of being inlined verbatim.
      sentences: [
        'Alpha fact stated here with plenty of additional descriptive words written out to comfortably exceed the inline summary threshold for this node.',
        'Beta fact stated here with plenty of additional descriptive words written out to comfortably exceed the inline summary threshold for this node.',
      ],
      topic_summaries: {},
    });

    llm.callLLMWithRetry.mockImplementation(async ({ prompt }) => {
      if (prompt.includes('Summarize the source text')) return 'NO_SUMMARY';
      return 'Leaf.';
    });

    await runPipeline('parent-nosummary');

    const doneCall = storage.updateRecord.mock.calls.find((c) => c[1].status === 'done');
    expect(doneCall).toBeDefined();
    expect(doneCall[1].status).toBe('done');
    const parentText = doneCall[1].topic_summary_index['Tech'].runs[0].text;
    expect(parentText).not.toBe('');
    // Falls back to the parent's own aggregated source sentences.
    expect(parentText).toContain('Alpha fact stated here');
    expect(parentText).toContain('Beta fact stated here');
  });

  it('falls back to chunk source text when an overflow chunk summary returns NO_SUMMARY', async () => {
    // Oversized parent whose per-chunk source summaries AND the merge both return
    // NO_SUMMARY. The fallback lives in the shared summarizeText, so each chunk
    // returns its raw source, and the overflow merge-fallback then joins those —
    // the parent ends non-empty (carrying source) rather than silently empty.
    const ids = Array.from({ length: 200 }, (_, i) => i + 1);
    const sentences = ids.map((i) => `Sentence ${i} ` + 'x'.repeat(390));
    storage.readRecord.mockResolvedValue({
      ...makeRecord('overflow-chunk-nosummary', '<p>x</p>'),
      status: 'summarizing',
      topics: [
        { name: 'Tech>A', sentences: ids.slice(0, 100), sentence_spans: [], ranges: [] },
        { name: 'Tech>B', sentences: ids.slice(100), sentence_spans: [], ranges: [] },
      ],
      sentences,
      topic_summaries: {},
    });

    llm.callLLMWithRetry.mockImplementation(async ({ prompt }) => {
      if (prompt.includes('Summarize the source text')) return 'NO_SUMMARY';
      if (prompt.includes('Merge the summaries below')) return 'NO_SUMMARY';
      return 'Leaf.';
    });

    await runPipeline('overflow-chunk-nosummary');

    const doneCall = storage.updateRecord.mock.calls.find((c) => c[1].status === 'done');
    expect(doneCall).toBeDefined();
    expect(doneCall[1].status).toBe('done');
    const parentText = doneCall[1].topic_summary_index['Tech'].runs[0].text;
    expect(parentText).not.toBe('');
    // Carries the raw source from the chunks (first and last sentences present).
    expect(parentText).toContain('Sentence 1 ');
    expect(parentText).toContain('Sentence 200 ');
  });

  it('clears stale topics and summaries on a fresh run (non-resume path)', async () => {
    storage.readRecord.mockResolvedValue({
      key: 'fresh1',
      html: `<p>${LONG_SUMMARY_TEXT}</p>`,
      status: 'pending',
      topics: [{ name: 'StaleTopic', sentences: [1], sentence_spans: [], ranges: [] }],
      topic_summaries: {
        StaleTopic: { text: 'Old summary.', source_sentences: [1] },
      },
      topic_summary_index: { StaleTopic: { text: 'Old' } },
    });

    html.stripTagsKeepOffsets.mockReturnValue({
      text: LONG_SUMMARY_TEXT,
      mapping: makeMapping(LONG_SUMMARY_TEXT),
    });
    sentenceSplitter.splitSentences.mockReturnValue([
      { text: LONG_SUMMARY_TEXT, start: 0, end: LONG_SUMMARY_TEXT.length },
    ]);
    llm.callLLMWithRetry.mockImplementation(async ({ prompt }) => {
      if (prompt.includes('Partition the markers')) return 'Tech>All: 0';
      if (prompt.includes('Summarize the text within the <text> tags')) return 'Fresh summary.';
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
      summaryErrors: [],
      forceFinalize: false,
      acceptedMergeFailurePaths: [],
      summaryCheckpointContentRevision: null,
      summariesDisabled: false,
      summariesIncomplete: false,
    });

    // The final result has only the fresh summaries.
    const doneCall = storage.updateRecord.mock.calls.find((call) => call[1].status === 'done');
    expect(doneCall[1].topic_summaries.StaleTopic).toBeUndefined();
    expect(doneCall[1].topic_summaries['Tech>All'].runs[0].text).toBe('Fresh summary.');
  });

  // -------------------------------------------------------------------------
  // skipSummaries run directive (persisted on the record at kickoff)
  // -------------------------------------------------------------------------

  it('skips all summary work and finalizes to done when the run skips summaries (fresh path)', async () => {
    const plainText = 'Sentence one. Sentence two.';
    const mapping = makeMapping(plainText);
    storage.readRecord.mockResolvedValue({
      ...makeRecord('disabled1', '<p>Sentence one. Sentence two.</p>'),
      skipSummaries: true,
    });
    html.stripTagsKeepOffsets.mockReturnValue({ text: plainText, mapping });
    sentenceSplitter.splitSentences.mockReturnValue([
      { text: 'Sentence one.', start: 0, end: 13 },
      { text: 'Sentence two.', start: 14, end: 27 },
    ]);
    llm.callLLMWithRetry.mockImplementation(async ({ prompt }) => {
      if (prompt.includes('Partition the markers')) return 'Tech>All: 0-1';
      // Any summary-shaped call would be a bug when summaries are disabled.
      return 'SHOULD_NOT_BE_CALLED';
    });

    await runPipeline('disabled1');

    // Topic ranges still run (the topic tree is still shown), but no summary
    // call of any kind fires.
    expect(
      llm.callLLMWithRetry.mock.calls.some(
        ([opts]) =>
          opts.prompt.includes('Summarize the text within the <text> tags') ||
          opts.prompt.includes('Summarize the source text'),
      ),
    ).toBe(false);

    const doneCall = storage.updateRecord.mock.calls.find((call) => call[1].status === 'done');
    expect(doneCall).toBeDefined();
    expect(doneCall[1].topic_summaries).toEqual({});
    expect(doneCall[1].topic_summary_index).toEqual({});
    expect(doneCall[1].summariesDisabled).toBe(true);
    expect(doneCall[1].progress).toEqual({ stage: 'done', done: 1, total: 1 });
  });

  it('skips all summary work when the run skips summaries and the record is resuming', async () => {
    storage.readRecord.mockResolvedValue({
      key: 'disabled2',
      html: '<p>ignored on resume</p>',
      status: 'summarizing',
      skipSummaries: true,
      sentences: ['Alpha.', 'Beta.'],
      topics: [{ name: 'A', sentences: [1, 2], sentence_spans: [], ranges: [] }],
      topic_summaries: {},
      topic_summary_index: {},
    });
    llm.callLLMWithRetry.mockResolvedValue('SHOULD_NOT_BE_CALLED');

    await runPipeline('disabled2');

    expect(llm.callLLMWithRetry).not.toHaveBeenCalled();
    // The resume path must not redo HTML cleaning / sentence splitting either.
    expect(html.stripTagsKeepOffsets).not.toHaveBeenCalled();
    expect(sentenceSplitter.splitSentences).not.toHaveBeenCalled();

    const doneCall = storage.updateRecord.mock.calls.find((call) => call[1].status === 'done');
    expect(doneCall).toBeDefined();
    expect(doneCall[1].topic_summaries).toEqual({});
    expect(doneCall[1].topic_summary_index).toEqual({});
    expect(doneCall[1].summariesDisabled).toBe(true);
  });

  it('finalizes with summariesDisabled: false when the record has no skipSummaries directive (default)', async () => {
    const plainText = 'Sentence one. Sentence two.';
    const mapping = makeMapping(plainText);
    storage.readRecord.mockResolvedValue(
      makeRecord('enabled1', '<p>Sentence one. Sentence two.</p>'),
    );
    html.stripTagsKeepOffsets.mockReturnValue({ text: plainText, mapping });
    sentenceSplitter.splitSentences.mockReturnValue([
      { text: 'Sentence one.', start: 0, end: 13 },
      { text: 'Sentence two.', start: 14, end: 27 },
    ]);
    llm.callLLMWithRetry.mockImplementation(async ({ prompt }) => {
      if (prompt.includes('Partition the markers')) return 'Tech>All: 0-1';
      if (prompt.includes('Summarize the text within the <text> tags')) return 'Summary text.';
      return '';
    });

    await runPipeline('enabled1');

    const doneCall = storage.updateRecord.mock.calls.find((call) => call[1].status === 'done');
    expect(doneCall).toBeDefined();
    expect(doneCall[1].summariesDisabled).toBe(false);
    expect(doneCall[1].topic_summaries['Tech>All'].runs[0].text).toBe(plainText);
  });

  it('generates summaries via the resume path for a record that finished without them', async () => {
    // Shape produced by the generateRecordSummaries handler: topics/sentences
    // kept from the original run, summaries empty, skipSummaries overridden to
    // false, status set back to 'summarizing'.
    storage.readRecord.mockResolvedValue({
      key: 'gen1',
      html: '<p>ignored on resume</p>',
      status: 'summarizing',
      skipSummaries: false,
      summariesDisabled: true,
      sentences: [LONG_SUMMARY_TEXT],
      topics: [{ name: 'Tech>All', sentences: [1], sentence_spans: [], ranges: [] }],
      topic_summaries: {},
      topic_summary_index: {},
    });
    llm.callLLMWithRetry.mockImplementation(async ({ prompt }) => {
      if (prompt.includes('Summarize the text within the <text> tags')) return 'Generated summary.';
      return '';
    });

    await runPipeline('gen1');

    // No reprocessing: HTML cleaning, sentence splitting, and topic ranges are
    // all reused from the stored record.
    expect(html.stripTagsKeepOffsets).not.toHaveBeenCalled();
    expect(sentenceSplitter.splitSentences).not.toHaveBeenCalled();
    expect(
      llm.callLLMWithRetry.mock.calls.some(([opts]) =>
        opts.prompt.includes('Partition the markers'),
      ),
    ).toBe(false);

    const doneCall = storage.updateRecord.mock.calls.find((call) => call[1].status === 'done');
    expect(doneCall).toBeDefined();
    expect(doneCall[1].topic_summaries['Tech>All'].runs[0].text).toBe('Generated summary.');
    // The "intentionally no summaries" outcome flag is cleared on finalize.
    expect(doneCall[1].summariesDisabled).toBe(false);
  });
});

describe('classifyLlmError', () => {
  it('classifies timeouts', () => {
    const r = classifyLlmError(new Error('LLM request timed out after 120000ms'));
    expect(r.kind).toBe('timeout');
    expect(r.message).toMatch(/did not respond/i);
  });

  it('classifies rate limits', () => {
    expect(classifyLlmError(new Error('LLM HTTP 429: too many requests')).kind).toBe(
      'rate_limited',
    );
    expect(classifyLlmError(new Error('rate limit exceeded')).kind).toBe('rate_limited');
  });

  it('classifies a missing provider', () => {
    expect(classifyLlmError(new Error('No LLM provider configured.')).kind).toBe('no_provider');
  });

  it('classifies auth failures', () => {
    expect(classifyLlmError(new Error('LLM HTTP 401: unauthorized')).kind).toBe('auth');
    expect(classifyLlmError(new Error('invalid api key')).kind).toBe('auth');
  });

  it('falls back to a capped raw message for unknown errors', () => {
    const long = 'x'.repeat(500);
    const r = classifyLlmError(new Error(long));
    expect(r.kind).toBe('error');
    expect(r.message.length).toBeLessThanOrEqual(201);
    expect(r.message.endsWith('…')).toBe(true);
  });

  it('handles non-Error values', () => {
    expect(classifyLlmError('plain string boom').kind).toBe('error');
    expect(classifyLlmError(null).kind).toBe('error');
  });
});
