import { describe, expect, it } from 'vitest';
import { PIPELINE_STAGE, PIPELINE_STATUS } from './contracts.js';
import {
  cancelledTransition,
  doneTransition,
  errorTransition,
  needsAttentionTransition,
  progressAt,
  queuedTransition,
  resetContentCheckpointPatch,
  resetSummaryCheckpointPatch,
  resetSummaryReviewPatch,
  RESPLIT_CANCELLED_NOTICE,
  RESPLIT_NO_CHANGE_NOTICE,
  restoreAfterResplitPatch,
  resumeSummariesTransition,
  splittingTransition,
  summarizingTransition,
} from './recordTransitions.js';

// The reset bundles are the invariant the builders exist to protect: every
// site that drops a checkpoint must clear exactly these fields together.
const REVIEW_RESET = {
  summaryErrors: [],
  forceFinalize: false,
  acceptedMergeFailurePaths: [],
  summariesIncomplete: false,
};
const SUMMARY_CHECKPOINT_RESET = {
  manualResplitIntent: null,
  resplitNotice: null,
  topics: [],
  topic_summaries: {},
  topic_summary_index: {},
  source_summary_units: {},
  ...REVIEW_RESET,
  summaryCheckpointContentRevision: null,
  summaryCheckpointPreferContentLanguage: null,
};

describe('recordTransitions', () => {
  it('progressAt defaults done/total to zero', () => {
    expect(progressAt(PIPELINE_STAGE.QUEUED)).toEqual({ stage: 'queued', done: 0, total: 0 });
    expect(progressAt(PIPELINE_STAGE.DONE, 3, 5)).toEqual({ stage: 'done', done: 3, total: 5 });
  });

  it('reset patches nest from review to full content', () => {
    expect(resetSummaryReviewPatch()).toEqual(REVIEW_RESET);
    expect(resetSummaryCheckpointPatch()).toEqual(SUMMARY_CHECKPOINT_RESET);
    expect(resetContentCheckpointPatch()).toEqual({
      ...SUMMARY_CHECKPOINT_RESET,
      sentences: [],
      text: '',
    });
  });

  it('returns fresh objects on every call', () => {
    const first = resetSummaryCheckpointPatch();
    first.topics.push('x');
    expect(resetSummaryCheckpointPatch().topics).toEqual([]);
  });

  it('queued and splitting transitions clear the previous error', () => {
    expect(queuedTransition()).toEqual({
      status: PIPELINE_STATUS.PENDING,
      error: null,
      progress: { stage: PIPELINE_STAGE.QUEUED, done: 0, total: 0 },
    });
    expect(splittingTransition()).toEqual({
      status: PIPELINE_STATUS.SPLITTING,
      error: null,
      progress: { stage: PIPELINE_STAGE.NORMALIZING_TEXT, done: 0, total: 0 },
    });
  });

  it('summarizingTransition can leave error untouched for mid-run writes', () => {
    expect(summarizingTransition({ total: 4 })).toEqual({
      status: PIPELINE_STATUS.SUMMARIZING,
      error: null,
      progress: { stage: PIPELINE_STAGE.SUMMARIZING_TOPICS, done: 0, total: 4 },
    });
    expect(summarizingTransition({ total: 4, clearError: false })).not.toHaveProperty('error');
  });

  it('resumeSummariesTransition clears review state but keeps caller directives', () => {
    expect(resumeSummariesTransition({ total: 2 })).toEqual({
      status: PIPELINE_STATUS.SUMMARIZING,
      error: null,
      progress: { stage: PIPELINE_STAGE.SUMMARIZING_TOPICS, done: 0, total: 2 },
      ...REVIEW_RESET,
    });
    expect(
      resumeSummariesTransition({
        total: 2,
        forceFinalize: true,
        acceptedMergeFailurePaths: ['a'],
      }),
    ).toMatchObject({ forceFinalize: true, acceptedMergeFailurePaths: ['a'], summaryErrors: [] });
  });

  it('needsAttentionTransition parks with the reported errors', () => {
    const errors = [{ topic: 'a', error_kind: 'timeout' }];
    expect(needsAttentionTransition(errors, { done: 1, total: 3 })).toEqual({
      status: PIPELINE_STATUS.NEEDS_ATTENTION,
      summaryErrors: errors,
      forceFinalize: false,
      summariesIncomplete: false,
      progress: { stage: PIPELINE_STAGE.NEEDS_ATTENTION, done: 1, total: 3 },
    });
  });

  it('doneTransition clears review state and carries the incomplete marker', () => {
    expect(doneTransition({ done: 3, total: 3, summariesDisabled: false })).toEqual({
      status: PIPELINE_STATUS.DONE,
      summariesDisabled: false,
      summariesIncomplete: false,
      progress: { stage: PIPELINE_STAGE.DONE, done: 3, total: 3 },
      ...REVIEW_RESET,
    });
    expect(
      doneTransition({ done: 3, total: 3, summariesDisabled: true, summariesIncomplete: true }),
    ).toMatchObject({ summariesDisabled: true, summariesIncomplete: true });
  });

  it('terminal cancel/error transitions', () => {
    expect(cancelledTransition()).toEqual({
      status: PIPELINE_STATUS.CANCELLED,
      error: 'Processing stopped.',
      summariesIncomplete: false,
      progress: { stage: PIPELINE_STAGE.CANCELLED, done: 0, total: 0 },
    });
    expect(errorTransition('boom')).toEqual({ status: PIPELINE_STATUS.ERROR, error: 'boom' });
  });

  it('restores a record to its pre-resplit completed state with a notice', () => {
    const previousProgress = { stage: PIPELINE_STAGE.DONE, done: 4, total: 4 };
    expect(
      restoreAfterResplitPatch(
        { topics: [{}, {}], manualResplitIntent: { previousProgress } },
        'No change.',
      ),
    ).toEqual({
      manualResplitIntent: null,
      resplitNotice: 'No change.',
      status: PIPELINE_STATUS.DONE,
      error: null,
      progress: previousProgress,
    });
    expect(
      restoreAfterResplitPatch({ topics: [{}, {}], manualResplitIntent: {} }, 'x').progress,
    ).toEqual({ stage: PIPELINE_STAGE.DONE, done: 2, total: 2 });
  });

  it('falls back to topic counts when the resplit intent is already cleared', () => {
    expect(
      restoreAfterResplitPatch({ topics: [{}, {}], manualResplitIntent: null }, 'x').progress,
    ).toEqual({ stage: PIPELINE_STAGE.DONE, done: 2, total: 2 });
  });

  it('falls back to an empty done progress when the record is missing', () => {
    expect(restoreAfterResplitPatch(undefined, 'No change.')).toEqual({
      manualResplitIntent: null,
      resplitNotice: 'No change.',
      status: PIPELINE_STATUS.DONE,
      error: null,
      progress: { stage: PIPELINE_STAGE.DONE, done: 0, total: 0 },
    });
  });

  it('pins the user-facing resplit notices', () => {
    expect(RESPLIT_NO_CHANGE_NOTICE).toBe(
      'Resplit returned the same topics; the topic was left unchanged.',
    );
    expect(RESPLIT_CANCELLED_NOTICE).toBe('Resplit stopped; the topic was left unchanged.');
  });
});
