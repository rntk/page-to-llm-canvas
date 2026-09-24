import { describe, expect, it, vi } from 'vitest';
import { MSG } from '../../../shared/runtime/messages.js';
import { createRecordHandlers } from './recordHandlers.js';

describe('record import failures', () => {
  it.each([
    ['first', 0],
    ['second', 1],
  ])('keeps the failed %s record’s existing pipeline running', async (_label, successfulWrites) => {
    const writeRecord = vi.fn().mockRejectedValue(new Error('storage full'));
    if (successfulWrites) writeRecord.mockResolvedValueOnce(true);
    const cancelActivePipeline = vi.fn();
    const clearPipelineFailuresForKey = vi.fn(async () => {});
    const handlers = createRecordHandlers({
      recordRepository: { writeRecord },
      pipelineSupervisor: {
        createPipelineRunId: vi.fn(() => 'new-run'),
        cancelActivePipeline,
        clearPipelineFailuresForKey,
      },
      summaryCheckpoint: { isComplete: vi.fn(), isRevisionCurrent: vi.fn() },
    });

    const response = await handlers[MSG.importRecords].handle({
      records: [
        { key: 'first', html: '<p>first</p>' },
        { key: 'second', html: '<p>second</p>' },
        { key: 'third', html: '<p>third</p>' },
      ],
    });

    expect(response).toEqual({ ok: false, count: successfulWrites, error: 'storage full' });
    expect(writeRecord).toHaveBeenCalledTimes(successfulWrites + 1);
    if (successfulWrites) {
      expect(cancelActivePipeline).toHaveBeenCalledExactlyOnceWith('first');
      expect(clearPipelineFailuresForKey).toHaveBeenCalledExactlyOnceWith('first');
    } else {
      expect(cancelActivePipeline).not.toHaveBeenCalled();
      expect(clearPipelineFailuresForKey).not.toHaveBeenCalled();
    }
  });
});
