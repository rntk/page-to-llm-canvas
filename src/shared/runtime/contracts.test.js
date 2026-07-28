import {
  createQueuedRecord,
  isImportableRecord,
  isInFlightPipelineStatus,
  isPipelineStage,
  isPipelineStatus,
  PIPELINE_STAGE,
  PIPELINE_STATUS,
} from './contracts.js';

describe('runtime contracts', () => {
  it('recognizes persisted pipeline statuses and stages', () => {
    expect(isPipelineStatus(PIPELINE_STATUS.DONE)).toBe(true);
    expect(isPipelineStatus('unknown')).toBe(false);
    expect(isPipelineStage(PIPELINE_STAGE.TOPIC_RANGES)).toBe(true);
    expect(isPipelineStage('unknown')).toBe(false);
    expect(isInFlightPipelineStatus(PIPELINE_STATUS.SUMMARIZING)).toBe(true);
    expect(isInFlightPipelineStatus(PIPELINE_STATUS.DONE)).toBe(false);
  });

  it('shares the minimum importable-record contract', () => {
    expect(isImportableRecord({ key: 'record-1', text: 'Article' })).toBe(true);
    expect(isImportableRecord({ key: 'record-1', sourceUrl: 'https://example.test' })).toBe(false);
    expect(isImportableRecord({ key: '   ', text: 'Article' })).toBe(false);
  });

  it('creates the canonical queued record shape', () => {
    expect(
      createQueuedRecord({
        key: 'record-1',
        html: '<p>Article</p>',
        sourceUrl: 'https://example.test/article',
        selectors: ['main'],
        pipelineRunId: 'run-1',
        skipSummaries: true,
        now: 123,
      }),
    ).toEqual({
      key: 'record-1',
      sourceUrl: 'https://example.test/article',
      html: '<p>Article</p>',
      text: '',
      status: 'pending',
      error: null,
      progress: { stage: 'queued', done: 0, total: 0 },
      sentences: [],
      topics: [],
      topic_summaries: {},
      topic_summary_index: {},
      processingLog: [],
      selectors: ['main'],
      pipelineRunId: 'run-1',
      skipSummaries: true,
      createdAt: 123,
      updatedAt: 123,
    });
  });
});
