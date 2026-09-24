import { describe, expect, it } from 'vitest';
import {
  isSummaryCheckpointComplete,
  isSummaryCheckpointRevisionCurrent,
  planResume,
} from './orchestrator.js';

const checkpoint = {
  status: 'summarizing',
  contentRevision: 'revision-2',
  summaryCheckpointContentRevision: 'revision-2',
  sentences: ['Source sentence.', 'Another sentence.'],
  topics: [{ name: 'Tech>AI', sentences: [1] }],
};

describe('summary checkpoint guards', () => {
  it('requires at least one topic with nonblank source text', () => {
    expect(isSummaryCheckpointComplete(checkpoint)).toBe(true);
    expect(
      isSummaryCheckpointComplete({ ...checkpoint, topics: [{ name: 'Empty', sentences: [] }] }),
    ).toBe(false);
    expect(
      isSummaryCheckpointComplete({
        ...checkpoint,
        sentences: ['   ', ''],
      }),
    ).toBe(false);
    expect(
      isSummaryCheckpointComplete({
        ...checkpoint,
        topics: [...checkpoint.topics, { name: 'Empty', sentences: [] }],
      }),
    ).toBe(true);
  });

  it('rejects a malformed topic even alongside a usable topic', () => {
    for (const topic of [
      { name: 'Out of range', sentences: [3] },
      { sentences: [1] },
      { name: ' ', sentences: [1] },
      { name: 'Wrong shape', sentences: '1' },
    ]) {
      expect(
        isSummaryCheckpointComplete({
          ...checkpoint,
          topics: [...checkpoint.topics, topic],
        }),
      ).toBe(false);
    }
  });

  it('treats missing, empty, and mismatched revisions as stale', () => {
    expect(isSummaryCheckpointRevisionCurrent(checkpoint)).toBe(true);
    for (const record of [
      { ...checkpoint, summaryCheckpointContentRevision: undefined },
      { ...checkpoint, contentRevision: undefined },
      { ...checkpoint, summaryCheckpointContentRevision: '' },
      { ...checkpoint, summaryCheckpointContentRevision: 'revision-1' },
    ]) {
      expect(isSummaryCheckpointRevisionCurrent(record)).toBe(false);
    }
  });

  it('resumes complete checkpoints, rebuilds stale ones, and preserves current malformed ones', () => {
    expect(planResume(checkpoint)).toEqual({ resuming: true, rejectionReason: null });
    expect(planResume({ ...checkpoint, summaryCheckpointContentRevision: undefined })).toEqual({
      resuming: false,
      rejectionReason: 'content_revision_mismatch',
    });
    expect(planResume({ ...checkpoint, topics: [{ name: 'Bad', sentences: [3] }] })).toEqual({
      resuming: false,
      rejectionReason: 'incomplete_checkpoint',
    });
    expect(planResume({ ...checkpoint, topics: [] })).toEqual({
      resuming: false,
      rejectionReason: 'incomplete_checkpoint',
    });
    expect(planResume({ ...checkpoint, status: 'pending' })).toEqual({
      resuming: false,
      rejectionReason: null,
    });
  });
});
