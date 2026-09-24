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

describe('record deletion cleanup', () => {
  function makeHandlers() {
    const recordRepository = {
      deleteRecord: vi.fn(async () => {}),
      deleteAll: vi.fn(async () => {}),
    };
    const pipelineSupervisor = {
      cancelActivePipeline: vi.fn(),
      cancelAll: vi.fn(),
      clearPipelineFailuresForKey: vi.fn(async () => {}),
    };
    return {
      recordRepository,
      pipelineSupervisor,
      handlers: createRecordHandlers({
        recordRepository,
        pipelineSupervisor,
        summaryCheckpoint: { isComplete: vi.fn(), isRevisionCurrent: vi.fn() },
      }),
    };
  }

  it('cancels the record job, deletes it, then clears its breaker entry', async () => {
    const { handlers, recordRepository, pipelineSupervisor } = makeHandlers();

    await expect(handlers[MSG.deleteRecord].handle({ key: 'article-1' })).resolves.toEqual({
      ok: true,
    });

    expect(pipelineSupervisor.cancelActivePipeline).toHaveBeenCalledExactlyOnceWith('article-1');
    expect(recordRepository.deleteRecord).toHaveBeenCalledExactlyOnceWith('article-1');
    expect(pipelineSupervisor.clearPipelineFailuresForKey).toHaveBeenCalledExactlyOnceWith(
      'article-1',
    );
  });

  it('cancels all jobs, deletes all records, then clears all breaker entries', async () => {
    const { handlers, recordRepository, pipelineSupervisor } = makeHandlers();

    await expect(handlers[MSG.deleteAll].handle({})).resolves.toEqual({ ok: true });

    expect(pipelineSupervisor.cancelAll).toHaveBeenCalledOnce();
    expect(recordRepository.deleteAll).toHaveBeenCalledOnce();
    expect(pipelineSupervisor.clearPipelineFailuresForKey).toHaveBeenCalledExactlyOnceWith();
  });
});
