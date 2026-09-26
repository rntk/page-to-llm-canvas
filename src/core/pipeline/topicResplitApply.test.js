import { describe, expect, it } from 'vitest';
import { applyTopicResplit, validateResplitTarget } from './topicResplitApply.js';

function makeRecord(overrides = {}) {
  return {
    sentences: ['s1', 's2', 's3', 's4', 's5', 's6'],
    topics: [
      { name: 'Intro', sentences: [1] },
      { name: 'Science', sentences: [2, 3, 4, 5] },
      { name: 'Outro', sentences: [6] },
    ],
    ...overrides,
  };
}

describe('validateResplitTarget', () => {
  it('accepts a contiguous card range of the target topic in either path spelling', () => {
    const record = makeRecord({
      topics: [
        { name: 'Science>Physics', sentences: [2, 3] },
        { name: 'Science>Chemistry', sentences: [4, 5] },
      ],
    });
    expect(
      validateResplitTarget(record, { path: 'Science', startSentence: 2, endSentence: 5 }),
    ).toBeNull();
    expect(
      validateResplitTarget(record, {
        path: 'Science > Physics',
        startSentence: 2,
        endSentence: 3,
      }),
    ).toBeNull();
  });

  it.each([
    [{ path: '', startSentence: 2, endSentence: 3 }, 'missing topic path'],
    [{ path: 'Science', startSentence: 2 }, 'missing topic sentence range'],
    [{ path: 'Science', startSentence: 0, endSentence: 3 }, 'invalid topic sentence range'],
    [{ path: 'Science', startSentence: 4, endSentence: 3 }, 'invalid topic sentence range'],
    [{ path: 'Science', startSentence: 2, endSentence: 7 }, 'outside the saved checkpoint'],
    [{ path: 'Science', startSentence: 1, endSentence: 3 }, 'stale'],
  ])('rejects %j', (target, message) => {
    expect(validateResplitTarget(makeRecord(), target)).toContain(message);
  });

  it('rejects a stale range that the topic run has since grown around', () => {
    const record = makeRecord({
      topics: [
        { name: 'Intro', sentences: [1] },
        { name: 'Science', sentences: [2, 3, 4, 5, 6] },
      ],
    });
    expect(
      validateResplitTarget(record, { path: 'Science', startSentence: 2, endSentence: 5 }),
    ).toMatch(/stale/);
    expect(
      validateResplitTarget(record, { path: 'Science', startSentence: 3, endSentence: 6 }),
    ).toMatch(/stale/);
  });

  it('rejects a record without a topic checkpoint', () => {
    expect(
      validateResplitTarget(
        { sentences: ['a'] },
        {
          path: 'Science',
          startSentence: 1,
          endSentence: 1,
        },
      ),
    ).toMatch(/incomplete/);
  });
});

describe('applyTopicResplit', () => {
  const target = { path: 'Science', startSentence: 2, endSentence: 5 };
  const replacement = [
    { name: 'Science>Physics', sentences: [2, 3] },
    { name: 'Science>Chemistry', sentences: [4, 5] },
  ];

  it('replaces the target range and keeps topics in article order', () => {
    const result = applyTopicResplit(makeRecord(), target, replacement);

    expect(result.topics).toEqual([
      { name: 'Intro', sentences: [1] },
      { name: 'Science>Physics', sentences: [2, 3] },
      { name: 'Science>Chemistry', sentences: [4, 5] },
      { name: 'Outro', sentences: [6] },
    ]);
  });

  it('replaces existing subtopics inside the range but keeps the topic outside it', () => {
    const record = makeRecord({
      topics: [
        { name: 'Science', sentences: [1] },
        { name: 'Science>Old', sentences: [2, 3, 4, 5] },
        { name: 'Outro', sentences: [6] },
      ],
    });

    const result = applyTopicResplit(record, target, replacement);

    expect(result.topics.map((topic) => topic.name)).toEqual([
      'Science',
      'Science>Physics',
      'Science>Chemistry',
      'Outro',
    ]);
  });

  it('merges replacement branches using the parser identity and keeps saved spellings', () => {
    const record = makeRecord({
      topics: [
        { name: 'Root>Physics', sentences: [1] },
        { name: 'Root>Old', sentences: [2, 3] },
      ],
      topic_summaries: {
        'Root>Physics': { runs: [{ sentences: [1], text: 'saved' }], source_sentences: [1] },
      },
    });

    const result = applyTopicResplit(record, { path: 'root', startSentence: 2, endSentence: 3 }, [
      { name: 'root>phy sics', sentences: [2, 3] },
    ]);

    expect(result.topics).toEqual([{ name: 'Root>Physics', sentences: [1, 2, 3] }]);
    expect(result.topic_summaries).toEqual({
      'Root>Physics': record.topic_summaries['Root>Physics'],
    });
  });

  it('returns null when the replacement reproduces the saved topics', () => {
    const record = makeRecord({ topics: [{ name: 'Science > Physics', sentences: [2, 3] }] });

    expect(
      applyTopicResplit(record, { path: 'Science>Physics', startSentence: 2, endSentence: 3 }, [
        { name: 'Science>Physics', sentences: [2, 3] },
      ]),
    ).toBeNull();
  });

  it('drops only the summary work that covered the replaced sentences', () => {
    const record = makeRecord({
      topics: [
        { name: 'Intro', sentences: [1] },
        { name: 'Science', sentences: [2, 3, 4, 5, 6] },
      ],
      topic_summaries: {
        Intro: { runs: [{ sentences: [1], text: 'intro' }], source_sentences: [1] },
        Science: {
          runs: [{ sentences: [2, 3, 4, 5, 6], text: 'science' }],
          source_sentences: [2, 3, 4, 5, 6],
        },
      },
      topic_summary_index: { Intro: { text: 'intro' }, Science: { text: 'science' } },
      source_summary_units: {
        intro: { run: [1] },
        science: { run: [2, 3, 4, 5, 6] },
        unrelated: {},
      },
    });

    const result = applyTopicResplit(record, target, replacement);

    expect(result.topics).toContainEqual({ name: 'Science', sentences: [6] });
    expect(result.topic_summaries).toEqual({
      Intro: record.topic_summaries.Intro,
      Science: { runs: [], source_sentences: [6] },
    });
    expect(result.topic_summary_index).toEqual({ Intro: { text: 'intro' } });
    expect(Object.keys(result.source_summary_units)).toEqual(['intro', 'unrelated']);
  });

  it('preserves summaries of every ancestor above the selected topic', () => {
    const record = makeRecord({
      topics: [
        { name: 'Root>Research>Science', sentences: [2, 3, 4, 5] },
        { name: 'Other', sentences: [1, 6] },
      ],
      topic_summary_index: {
        Root: { runs: [{ sentences: [2, 3, 4, 5], text: 'root' }] },
        'Root>Research': { runs: [{ sentences: [2, 3, 4, 5], text: 'research' }] },
        'Root>Research>Science': { runs: [{ sentences: [2, 3, 4, 5], text: 'old science' }] },
        Other: { text: 'other' },
      },
    });

    const result = applyTopicResplit(
      record,
      { path: 'Root>Research>Science', startSentence: 2, endSentence: 5 },
      [
        { name: 'Root>Research>Physics', sentences: [2, 3] },
        { name: 'Root>Research>Chemistry', sentences: [4, 5] },
      ],
    );

    expect(result.topic_summary_index).toEqual({
      Root: record.topic_summary_index.Root,
      'Root>Research': record.topic_summary_index['Root>Research'],
      Other: { text: 'other' },
    });
  });

  it('keeps ancestor tree runs both inside and outside the replaced range', () => {
    const record = makeRecord({
      topics: [
        { name: 'Root>Science', sentences: [2, 3] },
        { name: 'Other', sentences: [4] },
        { name: 'Root>Science', sentences: [5, 6] },
      ],
      topic_summary_index: {
        Root: {
          level: 1,
          source_sentences: [2, 3, 5, 6],
          runs: [
            { sentences: [2, 3], text: 'first' },
            { sentences: [5, 6], text: 'second' },
          ],
        },
      },
    });

    const result = applyTopicResplit(
      record,
      { path: 'Root>Science', startSentence: 2, endSentence: 3 },
      [
        { name: 'Root>Science>Physics', sentences: [2] },
        { name: 'Root>Science>Chemistry', sentences: [3] },
      ],
    );

    expect(result.topic_summary_index).toEqual({
      Root: {
        level: 1,
        source_sentences: [2, 3, 5, 6],
        runs: [
          { sentences: [2, 3], text: 'first' },
          { sentences: [5, 6], text: 'second' },
        ],
      },
    });
  });
});
