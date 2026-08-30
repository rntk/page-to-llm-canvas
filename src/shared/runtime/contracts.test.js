import { describe, expect, it } from 'vitest';
import {
  createQueuedRecord,
  IN_FLIGHT_PIPELINE_STATUSES,
  isImportableRecord,
  isInFlightPipelineStatus,
  isSummaryGenerationSourceStatus,
  PIPELINE_STATUS,
  SUMMARY_GENERATION_SOURCE_STATUSES,
} from './contracts.js';

describe('runtime contracts', () => {
  it('recognizes persisted pipeline statuses and stages', () => {
    expect(isInFlightPipelineStatus(PIPELINE_STATUS.SUMMARIZING)).toBe(true);
    expect(isInFlightPipelineStatus(PIPELINE_STATUS.DONE)).toBe(false);
    expect(isSummaryGenerationSourceStatus(PIPELINE_STATUS.ERROR)).toBe(true);
    expect(isSummaryGenerationSourceStatus(PIPELINE_STATUS.SUMMARIZING)).toBe(false);
    expect([...IN_FLIGHT_PIPELINE_STATUSES]).toEqual(['pending', 'splitting', 'summarizing']);
    expect([...SUMMARY_GENERATION_SOURCE_STATUSES]).toEqual(['done', 'cancelled', 'error']);
    expect(Object.isFrozen(IN_FLIGHT_PIPELINE_STATUSES)).toBe(true);
    expect(Object.isFrozen(SUMMARY_GENERATION_SOURCE_STATUSES)).toBe(true);
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
      captureVersion: null,
      capturedText: null,
      pipelineRunId: 'run-1',
      skipSummaries: true,
      summaryCheckpointContentRevision: null,
      summaryCheckpointPreferContentLanguage: null,
      createdAt: 123,
      updatedAt: 123,
    });
  });
});
