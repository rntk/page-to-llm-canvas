import { describe, it, expect } from 'vitest';
import { computeMaxTopicLevelForRecord } from './topicDomain.js';

// ── computeMaxTopicLevelForRecord ───────────────────────────────────────────

describe('computeMaxTopicLevelForRecord', () => {
  it('returns 0 for an empty record', () => {
    expect(computeMaxTopicLevelForRecord({})).toBe(0);
  });

  it('returns 0 for a nullish record', () => {
    expect(computeMaxTopicLevelForRecord(null)).toBe(0);
    expect(computeMaxTopicLevelForRecord(undefined)).toBe(0);
  });

  it('derives depth from topic name paths', () => {
    const record = {
      topics: [{ name: 'A' }, { name: 'A > B > C' }, { name: 'A > B' }],
    };
    expect(computeMaxTopicLevelForRecord(record)).toBe(2);
  });

  it('uses explicit entry.level from topic_summary_index', () => {
    const record = {
      topics: [{ name: 'A' }],
      topic_summary_index: {
        'A > B': { level: 4 },
      },
    };
    expect(computeMaxTopicLevelForRecord(record)).toBe(4);
  });

  it('infers summary index level from path depth when entry.level is absent', () => {
    const record = {
      topic_summary_index: {
        'A > B > C': {},
      },
    };
    expect(computeMaxTopicLevelForRecord(record)).toBe(2);
  });

  it('infers summary index level from path depth when an entry is nullish', () => {
    const record = {
      topic_summary_index: {
        'A > B > C': null,
      },
    };
    expect(computeMaxTopicLevelForRecord(record)).toBe(2);
  });

  it('skips empty-key summary index entries', () => {
    const record = {
      topics: [{ name: 'A > B' }],
      topic_summary_index: {
        '': { level: 9 },
      },
    };
    expect(computeMaxTopicLevelForRecord(record)).toBe(1);
  });

  it('takes the max across topics and topic_summary_index', () => {
    const record = {
      topics: [{ name: 'A > B' }],
      topic_summary_index: {
        'X > Y > Z': { level: 2 },
      },
    };
    expect(computeMaxTopicLevelForRecord(record)).toBe(2);
  });

  it('handles non-array topics and non-object index gracefully', () => {
    expect(computeMaxTopicLevelForRecord({ topics: null, topic_summary_index: null })).toBe(0);
  });
});
