import { describe, expect, it, vi } from 'vitest';
import {
  chunkSourceSentences,
  makeSourceSummarizer,
  parseSummaryResponse,
  parseSummaryResult,
  runSourceText,
  shouldInlineRun,
} from './sourceSummarizer.js';
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
    expect(typeof runSourceText([1, 9], ['first'])).toBe('string');
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
      { start: 1, end: 1, text: 'aa' },
      { start: 2, end: 3, text: 'bbb c' },
    ]);
    expect(chunkSourceSentences([], ['one'], 20)).toEqual([]);
    expect(chunkSourceSentences([1], [''], 20)).toEqual([]);
    expect(chunkSourceSentences([1, 4], ['one', 'two', 'three', 'four'], 20)).toEqual([
      { start: 1, end: 4, text: 'one four' },
    ]);
  });
});

describe('makeSourceSummarizer', () => {
  const make = (sentenceTexts, callLLMWithRetry = vi.fn(async () => 'summary')) => {
    const limit = vi.fn((work) => work());
    const summarize = makeSourceSummarizer({
      sentenceTexts,
      limit,
      signal: undefined,
      preferContentLanguage: true,
      callLLMWithRetry,
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
    );
    expect(callLLMWithRetry.mock.calls[0][0].prompt).toContain('LANGUAGE:');
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
});
