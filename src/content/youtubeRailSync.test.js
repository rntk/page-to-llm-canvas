import { describe, it, expect } from 'vitest';
import { buildYouTubeRailCards, findActiveCardIndex } from './youtubeRailSync.js';

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
    expect(cards[0].accent).toBeTruthy();
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
