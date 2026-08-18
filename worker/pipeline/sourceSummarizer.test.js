import { describe, expect, it, vi } from 'vitest';
import {
  chunkSourceSentences,
  makeSourceSummarizer,
  parseSummaryResponse,
  parseSummaryResult,
  runSourceText,
  shouldInlineRun,
} from './sourceSummarizer.js';
import { makeCachedSourceSummarizer, sourceSummaryUnitId } from './sourceSummaryCache.js';
import { isProviderFailure, markProviderFailure } from './providerFailure.js';

describe('parseSummaryResult', () => {
  it('normalizes empty, fenced, and explicit no-summary responses', () => {
    expect(parseSummaryResult(null)).toEqual({ text: '', noSummary: false });
    expect(parseSummaryResult('  summary with surrounding whitespace  ')).toEqual({
      text: 'summary with surrounding whitespace',
      noSummary: false,
    });
    expect(parseSummaryResult('```text   \nA concise summary.\n```')).toEqual({
      text: 'A concise summary.',
      noSummary: false,
    });
    expect(parseSummaryResult(' NO_SUMMARY. ')).toEqual({ text: '', noSummary: true });
    expect(parseSummaryResult('NO_SUMMARY extra')).toEqual({
      text: 'NO_SUMMARY extra',
      noSummary: false,
    });
    expect(parseSummaryResult('prefix ```text\ncontent')).toEqual({
      text: 'prefix ```text\ncontent',
      noSummary: false,
    });
    expect(parseSummaryResult('content ``` trailing')).toEqual({
      text: 'content ``` trailing',
      noSummary: false,
    });
    expect(parseSummaryResult('content NO_SUMMARY')).toEqual({
      text: 'content NO_SUMMARY',
      noSummary: false,
    });
    expect(parseSummaryResponse('  useful answer  ')).toBe('useful answer');
  });
});

describe('markProviderFailure', () => {
  it('marks an ordinary error in place and recognizes it through a cause chain', () => {
    const error = new Error('timed out');

    expect(markProviderFailure(error)).toBe(error);
    expect(isProviderFailure(error)).toBe(true);
    expect(isProviderFailure(new Error('wrapped', { cause: error }))).toBe(true);
  });

  it('wraps values that cannot carry the marker instead of mutating them', () => {
    const marked = markProviderFailure('plain failure');

    expect(marked).toBeInstanceOf(Error);
    expect(marked.message).toBe('plain failure');
    expect(marked.cause).toBe('plain failure');
    expect(isProviderFailure(marked)).toBe(true);

    const frozen = Object.freeze(new Error('frozen failure'));
    const markedFrozen = markProviderFailure(frozen);

    expect(markedFrozen).not.toBe(frozen);
    expect(markedFrozen.cause).toBe(frozen);
    expect(isProviderFailure(markedFrozen)).toBe(true);
    expect(isProviderFailure(frozen)).toBe(false);
  });

  it('keeps a wrapped cancellation recognizable and tolerates cyclic causes', () => {
    const abortError = new Error('LLM request aborted');
    abortError.name = 'AbortError';
    Object.freeze(abortError);

    expect(markProviderFailure(abortError).name).toBe('AbortError');

    const cyclic = new Error('cyclic');
    cyclic.cause = cyclic;
    expect(isProviderFailure(cyclic)).toBe(false);
    expect(isProviderFailure(undefined)).toBe(false);
  });
});

describe('source run helpers', () => {
  it('joins existing one-based sentence ids and ignores missing sentences', () => {
    expect(runSourceText([3, 1, 9], ['one', 'two', 'three'])).toBe('three one');
    expect(runSourceText([1, 3], ['  first', 'second', 'third  '])).toBe('first third');
    expect(runSourceText([1, 9], ['first'])).toBe('first');
    expect(runSourceText([], ['one'])).toBe('');
  });

  it('inlines only short, non-empty runs', () => {
    expect(shouldInlineRun([1, 2], 'one two')).toBe(true);
    expect(shouldInlineRun([], '')).toBe(true);
    expect(shouldInlineRun([1, 2, 3, 4], 'one two three four')).toBe(false);
    expect(shouldInlineRun([1, 2, 3, 4], '')).toBe(true);
    expect(shouldInlineRun([1], 'word '.repeat(35).trim())).toBe(true);
    expect(shouldInlineRun([1], 'word '.repeat(36).trim())).toBe(false);
    expect(shouldInlineRun([1], 'x'.repeat(280))).toBe(true);
    expect(shouldInlineRun([1], 'x'.repeat(281))).toBe(false);
    expect(shouldInlineRun([1], ' '.repeat(281))).toBe(true);
  });

  it('chunks at sentence boundaries and retains global sentence ranges', () => {
    expect(chunkSourceSentences([1, 2, 3], ['aa', 'bbb', 'c'], 6)).toEqual([
      { start: 1, end: 2, text: 'aa bbb' },
      { start: 3, end: 3, text: 'c' },
    ]);
    expect(chunkSourceSentences([], ['one'], 20)).toEqual([]);
    expect(chunkSourceSentences([1], [''], 20)).toEqual([]);
    expect(chunkSourceSentences([1, 4], ['one', 'two', 'three', 'four'], 20)).toEqual([
      { start: 1, end: 4, text: 'one four' },
    ]);
  });

  it('splits a single pathological sentence without exceeding or dropping source text', () => {
    const source = 'x'.repeat(25);
    const chunks = chunkSourceSentences([1], [source], 10);

    expect(chunks).toEqual([
      { start: 1, end: 1, text: 'x'.repeat(10), part: 0 },
      { start: 1, end: 1, text: 'x'.repeat(10), part: 1 },
      { start: 1, end: 1, text: 'x'.repeat(5), part: 2 },
    ]);
    expect(chunks.map((chunk) => chunk.text).join('')).toBe(source);
  });
});

describe('makeSourceSummarizer', () => {
  const make = (sentenceTexts, callLLMWithRetry = vi.fn(async () => 'summary'), overrides = {}) => {
    const limit = vi.fn((work) => work());
    const summarize = makeCachedSourceSummarizer({
      sentenceTexts,
      limit,
      signal: undefined,
      preferContentLanguage: true,
      callLLMWithRetry,
      ...overrides,
    });
    return { summarize, callLLMWithRetry, limit };
  };

  it('returns short contiguous source runs without an LLM request', async () => {
    const { summarize, callLLMWithRetry } = make(['one', 'two', 'far away']);

    await expect(summarize([1, 2, 3])).resolves.toEqual({
      runs: [{ sentences: [1, 2, 3], text: 'one two far away' }],
    });
    expect(callLLMWithRetry).not.toHaveBeenCalled();
  });

  it('summarizes a long run and falls back to source when the response is empty', async () => {
    const text = 'word '.repeat(60).trim();
    const { summarize, callLLMWithRetry } = make(
      [text],
      vi.fn(async () => ''),
    );

    await expect(summarize([1])).resolves.toEqual({
      runs: [{ sentences: [1], text }],
    });
    expect(callLLMWithRetry).toHaveBeenCalledTimes(1);
    expect(callLLMWithRetry).toHaveBeenCalledWith(
      expect.objectContaining({ temperature: 0.8, signal: undefined }),
      expect.any(Number),
    );
    expect(callLLMWithRetry.mock.calls[0][0].prompt).toContain('LANGUAGE:');
  });

  it('persists and reuses a provider-backed non-inline run as a single unit', async () => {
    const text = 'word '.repeat(60).trim();
    const persistedUnits = {};
    const persistUnit = vi.fn(async (unit) => {
      persistedUnits[unit.unitId] = unit;
    });
    const firstCall = vi.fn(async () => 'single summary');

    const { summarize } = make([text], firstCall, {
      contentRevision: 'rev-1',
      inputFingerprint: 'settings-a',
      persistUnit,
    });

    await expect(summarize([1], { path: 'Tech>All' })).resolves.toEqual({
      runs: [{ sentences: [1], text: 'single summary' }],
    });
    expect(firstCall).toHaveBeenCalledTimes(1);
    expect(persistUnit).toHaveBeenCalledTimes(1);

    const expectedSingleId = sourceSummaryUnitId({
      kind: 'single',
      path: 'Tech>All',
      runSentences: [1],
      startSentence: 1,
      endSentence: 1,
    });
    expect(persistedUnits[expectedSingleId]).toMatchObject({
      kind: 'single',
      path: 'Tech>All',
      run: [1],
      start_sentence: 1,
      end_sentence: 1,
      contentRevision: 'rev-1',
      status: 'done',
      result: 'single summary',
    });

    const secondCall = vi.fn();
    const { summarize: reused } = make([text], secondCall, {
      contentRevision: 'rev-1',
      inputFingerprint: 'settings-a',
      priorUnits: persistedUnits,
      persistUnit,
    });

    await expect(reused([1], { path: 'Tech>All' })).resolves.toEqual({
      runs: [{ sentences: [1], text: 'single summary' }],
    });
    expect(secondCall).not.toHaveBeenCalled();
  });

  it('rejects invalid single prior units and recomputes the provider-backed run', async () => {
    const text = 'word '.repeat(60).trim();
    const singleId = sourceSummaryUnitId({
      kind: 'single',
      path: 'Tech>All',
      runSentences: [1],
      startSentence: 1,
      endSentence: 1,
    });
    const priorUnits = {
      [singleId]: {
        unitId: singleId,
        kind: 'single',
        path: 'Tech>All',
        run: [1],
        start_sentence: 1,
        end_sentence: 1,
        contentRevision: 'old-rev',
        inputFingerprint: '',
        status: 'done',
        result: 123,
      },
    };
    const callLLMWithRetry = vi.fn(async () => 'fresh summary');
    const { summarize } = make([text], callLLMWithRetry, {
      contentRevision: 'rev-1',
      inputFingerprint: 'settings-b',
      priorUnits,
    });

    await expect(summarize([1], { path: 'Tech>All' })).resolves.toEqual({
      runs: [{ sentences: [1], text: 'fresh summary' }],
    });
    expect(callLLMWithRetry).toHaveBeenCalledTimes(1);
  });

  it('uses one merge request for an oversized run and falls back to chunk summaries', async () => {
    const sentenceTexts = Array.from(
      { length: 3 },
      (_, index) => `${index + 1} ${'x'.repeat(30000)}`,
    );
    const callLLMWithRetry = vi
      .fn()
      .mockResolvedValueOnce('chunk one')
      .mockResolvedValueOnce('chunk two')
      .mockResolvedValueOnce('chunk three')
      .mockResolvedValueOnce('');
    const { summarize, limit } = make(sentenceTexts, callLLMWithRetry);

    await expect(summarize([1, 2, 3])).resolves.toEqual({
      runs: [{ sentences: [1, 2, 3], text: 'chunk one\nchunk two\nchunk three' }],
    });
    expect(callLLMWithRetry).toHaveBeenCalledTimes(4);
    expect(limit).toHaveBeenCalledTimes(4);
    expect(callLLMWithRetry.mock.calls.at(-1)[0]).toEqual(
      expect.objectContaining({ temperature: 0.8 }),
    );
    expect(callLLMWithRetry.mock.calls.at(-1)[0].prompt).toContain('LANGUAGE:');
  });

  it('stops after a singleton merge round makes no progress', async () => {
    const sentenceTexts = Array.from({ length: 4 }, (_, index) => `${index + 1} ${'x'.repeat(78)}`);
    let chunkCall = 0;
    const callLLMWithRetry = vi.fn(async ({ prompt }) => {
      if (prompt.includes('Merge the summaries below')) return 'NO_SUMMARY';
      chunkCall++;
      return `chunk-${chunkCall}-${'s'.repeat(34)}`;
    });
    const { summarize } = make(sentenceTexts, callLLMWithRetry, { maxChars: 100 });

    const result = await summarize([1, 2, 3, 4]);

    expect(result.runs[0].text).toBe(
      Array.from({ length: 4 }, (_, index) => `chunk-${index + 1}-${'s'.repeat(34)}`).join('\n'),
    );
    const mergeCalls = callLLMWithRetry.mock.calls.filter(([options]) =>
      options.prompt.includes('Merge the summaries below'),
    );
    expect(mergeCalls).toHaveLength(4);
  });

  it('returns the latest successful records when the merge-round cap is reached', async () => {
    const sentenceTexts = Array.from({ length: 4 }, (_, index) => `${index + 1} ${'x'.repeat(78)}`);
    let chunkCall = 0;
    let mergeCall = 0;
    const callLLMWithRetry = vi.fn(async ({ prompt }) => {
      if (prompt.includes('Merge the summaries below')) {
        mergeCall++;
        return `merged-${String(mergeCall).padStart(2, '0')}-${'m'.repeat(32)}`;
      }
      chunkCall++;
      return `chunk-${chunkCall}-${'s'.repeat(34)}`;
    });
    const persistedUnits = [];
    const { summarize } = make(sentenceTexts, callLLMWithRetry, {
      maxChars: 100,
      contentRevision: 'rev-merge-rounds',
      persistUnit: async (unit) => persistedUnits.push(unit),
    });

    const result = await summarize([1, 2, 3, 4]);

    expect(mergeCall).toBe(32);
    expect(result.runs[0].text).toContain('merged-29-');
    expect(result.runs[0].text).toContain('merged-32-');
    expect(result.runs[0].text).not.toContain('chunk-1-');
    expect(persistedUnits).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'merge', part: '1:0' })]),
    );
  });

  it('keeps oversized leaf summaries bounded and preserves the leaf output contract', async () => {
    const sentenceTexts = Array.from({ length: 4 }, (_, index) => `${index + 1} ${'x'.repeat(78)}`);
    const callLLMWithRetry = vi
      .fn()
      .mockResolvedValueOnce('chunk one')
      .mockResolvedValueOnce('chunk two')
      .mockResolvedValueOnce('merged leaf');
    const { summarize } = make(sentenceTexts, callLLMWithRetry, {
      summaryMode: 'leaf',
      maxChars: 200,
    });

    await expect(summarize([1, 2, 3, 4], { path: 'Tech>Leaf' })).resolves.toEqual({
      runs: [{ sentences: [1, 2, 3, 4], text: 'merged leaf' }],
    });
    expect(callLLMWithRetry).toHaveBeenCalledTimes(3);
    expect(callLLMWithRetry.mock.calls[0][0].prompt).toContain('one concise sentence');
    expect(callLLMWithRetry.mock.calls.at(-1)[0].prompt).toContain(
      'Return plain text only: a single sentence, no bullets.',
    );
  });

  it('preserves separated runs and skips invalid sentence ids', async () => {
    const { summarize, callLLMWithRetry } = make(['first', 'second', 'third']);

    await expect(summarize([3, 1, 99])).resolves.toEqual({
      runs: [
        { sentences: [1], text: 'first' },
        { sentences: [3], text: 'third' },
      ],
    });
    expect(callLLMWithRetry).not.toHaveBeenCalled();
    await expect(summarize('not-an-array')).resolves.toEqual({ runs: [] });
  });

  it('ignores non-positive, fractional, and out-of-range ids but preserves empty text entries', async () => {
    const { summarize, callLLMWithRetry } = make(['']);

    await expect(summarize([0, -1, 1.5, 2, 1])).resolves.toEqual({
      runs: [{ sentences: [1], text: '' }],
    });
    expect(callLLMWithRetry).not.toHaveBeenCalled();
  });

  it('summarizes a source exactly at the maximum size without chunking', async () => {
    const { summarize, callLLMWithRetry } = make(
      ['x'.repeat(60000)],
      vi.fn(async () => 'summary'),
    );

    await expect(summarize([1])).resolves.toEqual({
      runs: [{ sentences: [1], text: 'summary' }],
    });
    expect(callLLMWithRetry).toHaveBeenCalledTimes(1);
  });

  it('marks a provider rejection as a provider failure through the limiter', async () => {
    const providerError = new Error('timed out');
    const { summarize } = make(
      ['word '.repeat(60).trim()],
      vi.fn(async () => {
        throw providerError;
      }),
    );

    await expect(summarize([1])).rejects.toBe(providerError);
    expect(isProviderFailure(providerError)).toBe(true);
  });

  it('leaves cache persistence failures unmarked after a successful provider call', async () => {
    const storageError = new Error('storage quota exceeded');
    const providerCall = vi.fn(async () => 'generated summary');
    const { summarize } = make(['word '.repeat(60).trim()], providerCall, {
      contentRevision: 'rev-1',
      persistUnit: vi.fn(async () => {
        throw storageError;
      }),
    });

    await expect(summarize([1])).rejects.toBe(storageError);
    expect(providerCall).toHaveBeenCalledTimes(1);
    expect(isProviderFailure(storageError)).toBe(false);
  });

  it('marks the chunk-merge rejection of an oversized run as a provider failure', async () => {
    const sentenceTexts = Array.from(
      { length: 3 },
      (_, index) => `${index + 1} ${'x'.repeat(30000)}`,
    );
    const mergeError = new Error('HTTP 429 from provider');
    const callLLMWithRetry = vi
      .fn()
      .mockResolvedValueOnce('chunk one')
      .mockResolvedValueOnce('chunk two')
      .mockResolvedValueOnce('chunk three')
      .mockRejectedValueOnce(mergeError);
    const { summarize } = make(sentenceTexts, callLLMWithRetry);

    await expect(summarize([1, 2, 3])).rejects.toBe(mergeError);
    expect(isProviderFailure(mergeError)).toBe(true);
  });

  it('leaves a response-parsing bug unmarked so callers do not treat it as retryable', async () => {
    const parseError = new TypeError('not a summary response');
    const { summarize } = make(
      ['word '.repeat(60).trim()],
      vi.fn(async () => ({
        toString() {
          throw parseError;
        },
      })),
    );

    await expect(summarize([1])).rejects.toBe(parseError);
    expect(isProviderFailure(parseError)).toBe(false);
  });

  it('defaults to the non-language-specific prompt mode', async () => {
    const callLLMWithRetry = vi.fn(async () => 'summary');
    const summarize = makeSourceSummarizer({
      sentenceTexts: ['word '.repeat(60).trim()],
      limit: (work) => work(),
      callLLMWithRetry,
    });

    await summarize([1]);
    expect(callLLMWithRetry.mock.calls[0][0].prompt).not.toContain('LANGUAGE:');
  });

  it('rejects an unknown summary mode instead of diverging from its cache key', () => {
    expect(() =>
      makeSourceSummarizer({
        sentenceTexts: ['source'],
        limit: (work) => work(),
        callLLMWithRetry: vi.fn(),
        summaryMode: 'typo',
      }),
    ).toThrow('Unknown source summary mode: typo');
  });

  it('persists chunk and merge units for oversized runs, then reuses them', async () => {
    const sentenceTexts = Array.from(
      { length: 3 },
      (_, index) => `${index + 1} ${'x'.repeat(30000)}`,
    );
    const persistedUnits = {};
    const persistUnit = vi.fn(async (unit) => {
      persistedUnits[unit.unitId] = unit;
    });
    const firstCall = vi
      .fn()
      .mockResolvedValueOnce('chunk one')
      .mockResolvedValueOnce('chunk two')
      .mockResolvedValueOnce('chunk three')
      .mockResolvedValueOnce('merged summary');
    const runIds = [1, 2, 3];

    const { summarize } = make(sentenceTexts, firstCall, {
      contentRevision: 'rev-1',
      inputFingerprint: 'settings-a',
      persistUnit,
    });

    await expect(summarize(runIds, { path: 'Tech>All' })).resolves.toEqual({
      runs: [{ sentences: runIds, text: 'merged summary' }],
    });
    expect(firstCall).toHaveBeenCalledTimes(4);
    expect(persistUnit).toHaveBeenCalledTimes(4);

    const expectedChunkId = sourceSummaryUnitId({
      kind: 'chunk',
      path: 'Tech>All',
      runSentences: runIds,
      startSentence: 1,
      endSentence: 1,
    });
    expect(persistedUnits[expectedChunkId]).toMatchObject({
      kind: 'chunk',
      path: 'Tech>All',
      run: runIds,
      start_sentence: 1,
      end_sentence: 1,
      contentRevision: 'rev-1',
      status: 'done',
      result: 'chunk one',
    });

    const expectedMergeId = sourceSummaryUnitId({
      kind: 'merge',
      path: 'Tech>All',
      runSentences: runIds,
      startSentence: 1,
      endSentence: 3,
    });
    expect(persistedUnits[expectedMergeId]).toMatchObject({
      kind: 'merge',
      path: 'Tech>All',
      run: runIds,
      start_sentence: 1,
      end_sentence: 3,
      contentRevision: 'rev-1',
      status: 'done',
      result: 'merged summary',
    });

    const secondCall = vi.fn();
    const { summarize: reused } = make(sentenceTexts, secondCall, {
      contentRevision: 'rev-1',
      inputFingerprint: 'settings-a',
      priorUnits: persistedUnits,
      persistUnit,
    });

    await expect(reused(runIds, { path: 'Tech>All' })).resolves.toEqual({
      runs: [{ sentences: runIds, text: 'merged summary' }],
    });
    expect(secondCall).not.toHaveBeenCalled();
  });

  it('rejects malformed or mismatched prior units and recomputes the oversized run', async () => {
    const sentenceTexts = Array.from(
      { length: 3 },
      (_, index) => `${index + 1} ${'x'.repeat(30000)}`,
    );
    const chunkId = sourceSummaryUnitId({
      kind: 'chunk',
      path: 'Tech>All',
      runSentences: [1, 2, 3],
      startSentence: 1,
      endSentence: 1,
    });
    const mergeId = sourceSummaryUnitId({
      kind: 'merge',
      path: 'Tech>All',
      runSentences: [1, 2, 3],
      startSentence: 1,
      endSentence: 3,
    });
    const priorUnits = {
      [chunkId]: {
        unitId: chunkId,
        kind: 'chunk',
        path: 'Tech>All',
        run: [1, 2, 3],
        start_sentence: 1,
        end_sentence: 1,
        contentRevision: 'rev-1',
        inputFingerprint: '',
        status: 'done',
        result: 123,
      },
      [mergeId]: {
        unitId: mergeId,
        kind: 'merge',
        path: 'Tech>All',
        run: [1, 2, 3],
        start_sentence: 1,
        end_sentence: 3,
        contentRevision: 'old-rev',
        inputFingerprint: 'stale-merge-fingerprint',
        status: 'done',
        result: 'stale merge',
      },
    };
    const callLLMWithRetry = vi
      .fn()
      .mockResolvedValueOnce('fresh chunk one')
      .mockResolvedValueOnce('fresh chunk two')
      .mockResolvedValueOnce('fresh chunk three')
      .mockResolvedValueOnce('fresh merge');
    const { summarize } = make(sentenceTexts, callLLMWithRetry, {
      contentRevision: 'rev-1',
      inputFingerprint: 'settings-b',
      priorUnits,
    });

    await expect(summarize([1, 2, 3], { path: 'Tech>All' })).resolves.toEqual({
      runs: [{ sentences: [1, 2, 3], text: 'fresh merge' }],
    });
    expect(callLLMWithRetry).toHaveBeenCalledTimes(4);
  });

  it('waits for sibling chunk persistence before surfacing a chunk failure', async () => {
    const sentenceTexts = Array.from(
      { length: 3 },
      (_, index) => `${index + 1} ${'x'.repeat(30000)}`,
    );
    const failure = new Error('chunk two failed');
    const events = [];
    const persistUnit = vi.fn(async (unit) => {
      events.push(`persist:${unit.start_sentence}:start`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      events.push(`persist:${unit.start_sentence}:done`);
    });
    const callLLMWithRetry = vi.fn(async ({ prompt }) => {
      if (prompt.includes(sentenceTexts[0])) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        events.push('chunk:1:done');
        return 'chunk one';
      }
      if (prompt.includes(sentenceTexts[1])) {
        events.push('chunk:2:failed');
        throw failure;
      }
      if (prompt.includes(sentenceTexts[2])) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        events.push('chunk:3:done');
        return 'chunk three';
      }
      return 'unused merge';
    });
    const { summarize } = make(sentenceTexts, callLLMWithRetry, {
      contentRevision: 'rev-1',
      persistUnit,
    });

    await expect(summarize([1, 2, 3], { path: 'Tech>All' })).rejects.toBe(failure);
    expect(events).toContain('chunk:2:failed');
    expect(events).toContain('persist:1:done');
    expect(events).toContain('persist:3:done');
    expect(persistUnit).toHaveBeenCalledTimes(2);
  });

  it('waits for other oversized runs to finish persisting before surfacing a run failure', async () => {
    const sentenceTexts = Array.from(
      { length: 5 },
      (_, index) => `${index + 1} ${'x'.repeat(30000)}`,
    );
    const failure = new Error('second run failed');
    const events = [];
    const persistUnit = vi.fn(async (unit) => {
      events.push(`persist:${unit.start_sentence}:${unit.kind}:start`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      events.push(`persist:${unit.start_sentence}:${unit.kind}:done`);
    });
    const callLLMWithRetry = vi.fn(async ({ prompt }) => {
      if (prompt.includes(sentenceTexts[0])) {
        await new Promise((resolve) => setTimeout(resolve, 15));
        events.push('run:1:chunk');
        return 'run one chunk';
      }
      if (prompt.includes(sentenceTexts[1])) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        events.push('run:1:chunk');
        return 'run one chunk two';
      }
      if (prompt.includes(sentenceTexts[2])) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        events.push('run:1:chunk');
        return 'run one chunk three';
      }
      if (prompt.includes('Chunk 1 (sentences 1-1)')) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        events.push('run:1:merge');
        return 'run one merged';
      }
      if (prompt.includes(sentenceTexts[4])) {
        events.push('run:2:failed');
        throw failure;
      }
      return 'unused merge';
    });
    const { summarize } = make(sentenceTexts, callLLMWithRetry, {
      contentRevision: 'rev-1',
      persistUnit,
    });

    await expect(summarize([1, 2, 3, 5], { path: 'Tech>All' })).rejects.toBe(failure);
    expect(events).toContain('run:2:failed');
    expect(events).toContain('run:1:merge');
    expect(events).toContain('persist:1:chunk:done');
    expect(events).toContain('persist:1:merge:done');
  });
});
