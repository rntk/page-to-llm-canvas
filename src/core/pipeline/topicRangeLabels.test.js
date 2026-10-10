import { describe, expect, it, vi } from 'vitest';
import {
  batchRangesForLabels,
  labelTopicRanges,
  LABEL_SECTION_MAX_CHARS,
  parseTopicLabels,
} from './topicRangeLabels.js';
import { TopicParseError } from './topicParser.js';
import { TOPIC_RANGE_STAGE_MAX_RETRIES } from './pipelineConfig.js';
import { makeRuntime } from '../../../test/fakes/pipelineFixtures.mjs';

describe('batchRangesForLabels', () => {
  const texts = ['aaaa', 'bbbb', 'cccc'];
  const ranges = [
    { start: 0, end: 0 },
    { start: 1, end: 1 },
    { start: 2, end: 2 },
  ];

  it('numbers sections locally within a batch', () => {
    const [batch, ...rest] = batchRangesForLabels(ranges, texts, 1000);
    expect(rest).toEqual([]);
    expect(batch.ranges).toEqual(ranges);
    expect(batch.text).toBe('[1]\naaaa\n[2]\nbbbb\n[3]\ncccc');
  });

  it('starts a new batch when the next section would exceed the character budget', () => {
    // "[1]\naaaa" is 8 chars; adding "\n[2]\nbbbb" brings it to 17.
    expect(batchRangesForLabels(ranges.slice(0, 2), texts, 17)).toHaveLength(1);
    const batches = batchRangesForLabels(ranges.slice(0, 2), texts, 16);
    expect(batches.map((batch) => batch.text)).toEqual(['[1]\naaaa', '[1]\nbbbb']);
    expect(batches.map((batch) => batch.ranges)).toEqual([[ranges[0]], [ranges[1]]]);
  });

  it('caps the number of sections per batch at 60', () => {
    const many = Array.from({ length: 125 }, (_, index) => ({ start: index, end: index }));
    const batches = batchRangesForLabels(
      many,
      many.map(() => 'x'),
      1_000_000,
    );
    expect(batches.map((batch) => batch.ranges.length)).toEqual([60, 60, 5]);
  });

  it('joins and collapses whitespace across a range', () => {
    const [batch] = batchRangesForLabels(
      [{ start: 0, end: 1 }],
      ['  one \n two ', 'three\t\tfour'],
      1000,
    );
    expect(batch.text).toBe('[1]\none two three four');
  });

  it('keeps the head and tail of an overlong section', () => {
    const [batch] = batchRangesForLabels(
      [{ start: 0, end: 0 }],
      [`${'a'.repeat(2000)}${'z'.repeat(2000)}`],
      100_000,
    );
    const body = batch.text.slice('[1]\n'.length);
    expect(body).toHaveLength(LABEL_SECTION_MAX_CHARS);
    expect(body).toMatch(/^a+…z+$/);
  });

  it('shrinks sections to fit a small request budget', () => {
    const [batch] = batchRangesForLabels([{ start: 0, end: 0 }], ['x'.repeat(100)], 20);
    expect(batch.text.slice('[1]\n'.length)).toHaveLength(12);
  });

  it('returns no batches for no ranges', () => {
    expect(batchRangesForLabels([], [], 100)).toEqual([]);
  });
});

describe('parseTopicLabels', () => {
  it('parses hierarchical labels one per section', () => {
    expect(parseTopicLabels('1: Science>AI\n2: Sports', 2)).toEqual([
      ['Science', 'AI'],
      ['Sports'],
    ]);
  });

  it('tolerates punctuation, brackets, bullets, bold, CRLF, and prose lines', () => {
    const response = [
      'Here are the labels:',
      '1. Alpha',
      '[2]: Beta > Gamma',
      '- 3) Delta',
      '**4:** Epsilon',
      '[5] - Zeta',
      '',
    ].join('\r\n');
    expect(parseTopicLabels(response, 5)).toEqual([
      ['Alpha'],
      ['Beta', 'Gamma'],
      ['Delta'],
      ['Epsilon'],
      ['Zeta'],
    ]);
  });

  it('replaces colons inside a label and collapses whitespace', () => {
    expect(parseTopicLabels('1: Tech:   AI > Cats\t& Dogs', 1)).toEqual([
      ['Tech AI', 'Cats & Dogs'],
    ]);
  });

  it('drops blank path segments', () => {
    expect(parseTopicLabels('1: A>>B>', 1)).toEqual([['A', 'B']]);
  });

  it('keeps the first label for a duplicated section and ignores out-of-range numbers', () => {
    expect(parseTopicLabels('1: First\n1: Second\n0: Zero\n3: Third\n2: Two', 2)).toEqual([
      ['First'],
      ['Two'],
    ]);
  });

  it('throws a TopicParseError naming every missing section', () => {
    let error;
    try {
      parseTopicLabels('1: A\n4: D', 4);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(TopicParseError);
    expect(error.message).toBe('Topic labels missing for sections 2, 3');
    expect(error.diagnostics.missing).toEqual([2, 3]);
    expect(error.diagnostics.labels).toEqual([['A'], null, null, ['D']]);
  });

  it('treats a label with no usable path segments as missing', () => {
    expect(() => parseTopicLabels('1: >\n2: **', 2)).toThrow(
      'Topic labels missing for sections 1, 2',
    );
  });

  it('reports all sections missing for an unparseable response', () => {
    expect(() => parseTopicLabels('no labels here', 2)).toThrow(TopicParseError);
  });
});

describe('labelTopicRanges', () => {
  const sentenceTexts = ['Cats purr.', 'Dogs bark.', 'Cats nap.', 'Birds sing.'];
  const ranges = [
    { start: 0, end: 0 },
    { start: 1, end: 1 },
    { start: 2, end: 2 },
    { start: 3, end: 3 },
  ];

  function makeLabelRuntime(overrides) {
    return makeRuntime({ maxTextChunkChars: 10_000, ...overrides });
  }

  it('returns no groups and makes no request for no ranges', async () => {
    const callLLMWithRetry = vi.fn();
    const groups = await labelTopicRanges({
      runtime: makeLabelRuntime(),
      ranges: [],
      sentenceTexts: [],
      callLLMWithRetry,
    });
    expect(groups).toEqual([]);
    expect(callLLMWithRetry).not.toHaveBeenCalled();
  });

  it('labels ranges in one request and merges ranges that share a path', async () => {
    const callLLMWithRetry = vi.fn(
      async () => '1: Pets>Cats\n2: Pets>Dogs\n3: pets > cats\n4: Birds',
    );
    const runtime = makeLabelRuntime({ preferContentLanguage: true });

    const groups = await labelTopicRanges({ runtime, ranges, sentenceTexts, callLLMWithRetry });

    expect(callLLMWithRetry).toHaveBeenCalledTimes(1);
    const [options, attempts] = callLLMWithRetry.mock.calls[0];
    expect(attempts).toBe(3);
    expect(options.signal).toBe(runtime.signal);
    expect(options.taskType).toEqual(expect.any(String));
    expect(options.prompt).toContain('[1]\nCats purr.\n[2]\nDogs bark.');
    expect(groups.map((group) => group.label)).toEqual([
      ['Pets', 'Cats'],
      ['Pets', 'Dogs'],
      ['Birds'],
    ]);
    expect(groups[0].ranges.map(({ start, end }) => ({ start, end }))).toEqual([
      { start: 0, end: 0 },
      { start: 2, end: 2 },
    ]);
  });

  it('numbers sections per batch and maps labels back to the right ranges', async () => {
    // A tiny budget forces one section per request.
    const runtime = makeLabelRuntime({ maxTextChunkChars: 20 });
    const callLLMWithRetry = vi.fn(async ({ prompt }) => {
      const body = /\[1\]\n(.*)/.exec(prompt)[1];
      return `1: ${body.replace('.', '')}`;
    });

    const groups = await labelTopicRanges({ runtime, ranges, sentenceTexts, callLLMWithRetry });

    expect(callLLMWithRetry).toHaveBeenCalledTimes(4);
    expect(groups.map((group) => group.label)).toEqual([
      ['Cats purr'],
      ['Dogs bark'],
      ['Cats nap'],
      ['Birds sing'],
    ]);
    expect(groups.map((group) => group.ranges[0].start)).toEqual([0, 1, 2, 3]);
  });

  it('keeps parsed labels and re-asks only the missing sections, renumbered', async () => {
    const callLLMWithRetry = vi
      .fn()
      .mockResolvedValueOnce('1: A\n3: C')
      .mockResolvedValueOnce('gibberish')
      .mockResolvedValueOnce('1: B\n2: D');
    const runtime = makeLabelRuntime();

    const groups = await labelTopicRanges({ runtime, ranges, sentenceTexts, callLLMWithRetry });

    expect(callLLMWithRetry).toHaveBeenCalledTimes(3);
    const retryPrompt = callLLMWithRetry.mock.calls[1][0].prompt;
    expect(retryPrompt).toContain('[1]\nDogs bark.\n[2]\nBirds sing.');
    expect(retryPrompt).not.toContain('Cats');
    expect(callLLMWithRetry.mock.calls[2][0].prompt).toBe(retryPrompt);
    expect(groups.map((group) => [group.label, group.ranges[0].start])).toEqual([
      [['A'], 0],
      [['B'], 1],
      [['C'], 2],
      [['D'], 3],
    ]);
    const retryLogs = runtime.log.mock.calls.filter(
      ([name]) => name === 'topic_labels_parse_retry',
    );
    expect(retryLogs.map(([, details]) => details.attempt)).toEqual([1, 2]);
    expect(retryLogs[0][1].error).toContain('missing for sections 2, 4');
    expect(
      runtime.log.mock.calls
        .filter(([name]) => name === 'topic_labels_llm_request')
        .map(([, details]) => details.sectionCount),
    ).toEqual([4, 2, 2]);
  });

  it('throws the parse error after exhausting retries', async () => {
    const callLLMWithRetry = vi.fn(async () => 'no labels here');

    await expect(
      labelTopicRanges({ runtime: makeLabelRuntime(), ranges, sentenceTexts, callLLMWithRetry }),
    ).rejects.toBeInstanceOf(TopicParseError);

    expect(callLLMWithRetry).toHaveBeenCalledTimes(TOPIC_RANGE_STAGE_MAX_RETRIES + 1);
  });

  it('does not retry provider errors', async () => {
    const error = new Error('provider down');
    const callLLMWithRetry = vi.fn(async () => {
      throw error;
    });

    await expect(
      labelTopicRanges({ runtime: makeLabelRuntime(), ranges, sentenceTexts, callLLMWithRetry }),
    ).rejects.toBe(error);
    expect(callLLMWithRetry).toHaveBeenCalledTimes(1);
  });

  it('uses the injected parallelMap with the batches', async () => {
    const parallelMap = vi.fn(async (items, _limit, fn) =>
      Promise.all(items.map((item, index) => fn(item, index))),
    );
    const callLLMWithRetry = vi.fn(async () => '1: X');

    await labelTopicRanges({
      runtime: makeLabelRuntime(),
      ranges: [{ start: 0, end: 0 }],
      sentenceTexts,
      callLLMWithRetry,
      parallelMap,
    });

    expect(parallelMap).toHaveBeenCalledTimes(1);
    expect(parallelMap.mock.calls[0][0]).toHaveLength(1);
  });
});
