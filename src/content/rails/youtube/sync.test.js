import { describe, it, expect } from 'vitest';
import { buildYouTubeRailCards, findActiveCardIndex } from './sync.js';

// Transcript sentences carry inline timestamps the way the YouTube capture emits
// them ("2:51 2 minutes, 51 seconds ..."). Sentence numbers are 1-based.
const sentences = [
  '0:00 0 seconds intro hello',
  '0:30 30 seconds first topic begins here',
  '1:00 1 minute, 0 seconds still first topic',
  '2:00 2 minutes, 0 seconds second topic begins',
];

const record = {
  sentences,
  topics: [
    { name: 'First', sentences: [2, 3] },
    { name: 'Second', sentences: [4] },
  ],
  topic_summary_index: {
    First: {
      runs: [{ sentences: [2, 3], text: 'about first' }],
      source_sentences: [2, 3],
      level: 0,
    },
    Second: { runs: [{ sentences: [4], text: 'about second' }], source_sentences: [4], level: 0 },
  },
};

describe('buildYouTubeRailCards', () => {
  it('builds timestamped topic cards sorted by seconds', () => {
    const cards = buildYouTubeRailCards({ record, mode: 'topics', selectedLevel: 0 });
    expect(cards.map((c) => [c.name, c.seconds])).toEqual([
      ['First', 30],
      ['Second', 120],
    ]);
    expect(cards[0].accent).toMatch(/^hsl\(/);
  });

  it('builds summary cards with their text', () => {
    const cards = buildYouTubeRailCards({ record, mode: 'summaries', selectedLevel: 0 });
    expect(cards.map((c) => [c.name, c.text, c.seconds])).toEqual([
      ['First', 'about first', 30],
      ['Second', 'about second', 120],
    ]);
  });

  it('scopes summaries to the selected hierarchy level', () => {
    const leveled = {
      sentences,
      topic_summary_index: {
        First: { runs: [{ sentences: [2], text: 'top level' }], source_sentences: [2], level: 0 },
        'First > Detail': {
          runs: [{ sentences: [4], text: 'child level' }],
          source_sentences: [4],
          level: 1,
        },
      },
    };
    expect(
      buildYouTubeRailCards({ record: leveled, mode: 'summaries', selectedLevel: 0 }).map(
        (c) => c.name,
      ),
    ).toEqual(['First']);
    expect(
      buildYouTubeRailCards({ record: leveled, mode: 'summaries', selectedLevel: 1 }).map(
        (c) => c.name,
      ),
    ).toEqual(['Detail']);
  });

  it('drops entries whose sentences have no resolvable timestamp', () => {
    const noTs = {
      sentences: ['plain text', 'still no timestamp'],
      topics: [{ name: 'Ghost', sentences: [1, 2] }],
    };
    expect(buildYouTubeRailCards({ record: noTs, mode: 'topics', selectedLevel: 0 })).toEqual([]);
  });

  it('returns [] for a missing record', () => {
    expect(buildYouTubeRailCards({ record: null, mode: 'topics' })).toEqual([]);
  });

  it('creates separate cards per occurrence for recurring topics with non-contiguous runs', () => {
    const recurringSentences = [
      '0:00 0 seconds intro',
      '0:30 30 seconds pricing discussed first time',
      '1:00 1 minute, 0 seconds architecture begins',
      '2:00 2 minutes, 0 seconds architecture continues',
      '18:00 18 minutes, 0 seconds pricing revisited',
    ];
    const recurringRecord = {
      sentences: recurringSentences,
      topics: [
        { name: 'Pricing', sentences: [2, 5] },
        { name: 'Architecture', sentences: [3, 4] },
      ],
    };

    const cards = buildYouTubeRailCards({
      record: recurringRecord,
      mode: 'topics',
      selectedLevel: 0,
    });
    expect(cards.map((c) => [c.name, c.seconds])).toEqual([
      ['Pricing', 30],
      ['Architecture', 60],
      ['Pricing', 1080],
    ]);
    expect(cards[0].sentences).toEqual([2]);
    expect(cards[1].sentences).toEqual([3, 4]);
    expect(cards[2].sentences).toEqual([5]);

    // Active card resolves correctly during both the first and second occurrences of Pricing
    const starts = cards.map((c) => c.seconds);
    expect(findActiveCardIndex(starts, 45)).toBe(0); // Pricing (first occurrence)
    expect(findActiveCardIndex(starts, 90)).toBe(1); // Architecture
    expect(findActiveCardIndex(starts, 1100)).toBe(2); // Pricing (recurrence)
  });

  it('merges runs of the same topic that map to the exact same timestamp', () => {
    const segmentedSentences = [
      '0:00 0 seconds intro',
      '0:30 30 seconds pricing point 1',
      'quick interjection without timestamp',
      'pricing point 2 still within the 30s block',
    ];
    const recordWithGap = {
      sentences: segmentedSentences,
      topics: [{ name: 'Pricing', sentences: [2, 4] }],
    };

    const cards = buildYouTubeRailCards({
      record: recordWithGap,
      mode: 'topics',
      selectedLevel: 0,
    });
    expect(cards.map((c) => [c.id, c.name, c.seconds, c.sentences])).toEqual([
      ['Pricing-2-4', 'Pricing', 30, [2, 4]],
    ]);
  });

  it('keeps distinct run-based ids in summaries mode when runs share a timestamp', () => {
    const segmentedSentences = [
      '0:00 0 seconds intro',
      '0:30 30 seconds pricing point 1',
      'quick interjection without timestamp',
      'pricing point 2 still within the 30s block',
    ];
    const recordWithRuns = {
      sentences: segmentedSentences,
      topic_summary_index: {
        Pricing: {
          runs: [
            { sentences: [2], text: 'First pricing chunk.' },
            { sentences: [4], text: 'Second pricing chunk.' },
          ],
          source_sentences: [2, 4],
          level: 0,
        },
      },
    };

    const cards = buildYouTubeRailCards({
      record: recordWithRuns,
      mode: 'summaries',
      selectedLevel: 0,
    });
    expect(cards.map((c) => [c.id, c.text, c.seconds])).toEqual([
      ['Pricing-2', 'First pricing chunk.', 30],
      ['Pricing-4', 'Second pricing chunk.', 30],
    ]);
    // The two cards have distinct unique IDs despite having the same path and seconds
    expect(cards[0].id).not.toBe(cards[1].id);
  });

  it('does not repeat identical summary text when a summary run spans a sentence gap', () => {
    const segmentedSentences = [
      '0:00 0 seconds intro',
      '0:30 30 seconds first mention',
      '1:00 1 minute, 0 seconds middle discussion',
      '2:00 2 minutes, 0 seconds second mention',
    ];
    const recordWithGapRun = {
      sentences: segmentedSentences,
      topic_summary_index: {
        Pricing: {
          runs: [
            { sentences: [2, 4], text: 'One summary blob covering both mentions.' },
          ],
          source_sentences: [2, 4],
          level: 0,
        },
      },
    };

    const cards = buildYouTubeRailCards({
      record: recordWithGapRun,
      mode: 'summaries',
      selectedLevel: 0,
    });
    expect(cards.map((c) => [c.name, c.text, c.seconds])).toEqual([
      ['Pricing', 'One summary blob covering both mentions.', 30],
    ]);
  });
});

describe('findActiveCardIndex', () => {
  const starts = [30, 120, 300];

  it('returns the last card at or before the current time', () => {
    expect(findActiveCardIndex(starts, 150)).toBe(1);
    expect(findActiveCardIndex(starts, 300)).toBe(2);
    expect(findActiveCardIndex(starts, 9999)).toBe(2);
  });

  it('clamps to the first card before the first timestamp', () => {
    expect(findActiveCardIndex(starts, 0)).toBe(0);
    expect(findActiveCardIndex(starts, 10)).toBe(0);
  });

  it('returns -1 when there are no cards', () => {
    expect(findActiveCardIndex([], 100)).toBe(-1);
  });

  it('falls back to the first card for a non-finite time', () => {
    expect(findActiveCardIndex(starts, NaN)).toBe(0);
  });
});
