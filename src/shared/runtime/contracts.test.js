import { describe, expect, it } from 'vitest';
import {
  createQueuedRecord,
  IN_FLIGHT_PIPELINE_STATUSES,
  isImportableRecord,
  isInFlightPipelineStatus,
  isPipelineStage,
  isPipelineStatus,
  PIPELINE_STAGE,
  PIPELINE_STATUS,
  SUMMARY_GENERATION_SOURCE_STATUSES,
} from './contracts.js';

describe('runtime contracts', () => {
  it('recognizes persisted pipeline statuses and stages', () => {
    expect(isPipelineStatus(PIPELINE_STATUS.DONE)).toBe(true);
    expect(isPipelineStatus('unknown')).toBe(false);
    expect(isPipelineStage(PIPELINE_STAGE.TOPIC_RANGES)).toBe(true);
    expect(isPipelineStage('unknown')).toBe(false);
    expect(isInFlightPipelineStatus(PIPELINE_STATUS.SUMMARIZING)).toBe(true);
    expect(isInFlightPipelineStatus(PIPELINE_STATUS.DONE)).toBe(false);
    expect([...IN_FLIGHT_PIPELINE_STATUSES]).toEqual(['pending', 'splitting', 'summarizing']);
    expect([...SUMMARY_GENERATION_SOURCE_STATUSES]).toEqual(['done', 'cancelled', 'error']);
  });

  it('shares the minimum importable-record contract', () => {
    expect(isImportableRecord({ key: 'record-1', html: '<p>Article</p>' })).toBe(true);
    expect(isImportableRecord({ key: 'record-1', sourceUrl: 'https://example.test' })).toBe(false);
    expect(isImportableRecord({ key: '   ', html: '<p>Article</p>' })).toBe(false);
    expect(isImportableRecord({ key: 'record-1', html: '' })).toBe(false);
    expect(isImportableRecord({ key: 'record-1', html: '   ' })).toBe(false);
  });

  it('rejects imported summary indexes with invalid levels', () => {
    expect(
      isImportableRecord({
        key: 'record-1',
        html: '<p>Article</p>',
        topic_summary_index: { Topic: { level: 0 } },
      }),
    ).toBe(true);
    expect(
      isImportableRecord({
        key: 'record-1',
        html: '<p>Article</p>',
        topic_summary_index: { Topic: { runs: [] } },
      }),
    ).toBe(false);
    expect(
      isImportableRecord({
        key: 'record-1',
        html: '<p>Article</p>',
        topic_summary_index: { Topic: { level: -1 } },
      }),
    ).toBe(false);
    expect(
      isImportableRecord({
        key: 'record-1',
        html: '<p>Article</p>',
        topic_summary_index: ['Topic'],
      }),
    ).toBe(false);
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
      source_summary_units: {},
      processingLog: [],
      selectors: ['main'],
      pipelineRunId: 'run-1',
      skipSummaries: true,
      summaryCheckpointContentRevision: null,
      createdAt: 123,
      updatedAt: 123,
    });
  });
});
