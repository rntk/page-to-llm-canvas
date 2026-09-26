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

describe('manual topic resplit handler', () => {
  function makeResplitHandler({
    summariesDisabled = false,
    checkpointComplete = true,
    topicPath = 'Science',
  } = {}) {
    const record = {
      key: 'topic-record',
      status: 'done',
      pipelineRunId: 'old-run',
      contentRevision: 'revision-1',
      summaryCheckpointContentRevision: 'revision-1',
      progress: { stage: 'done', done: 1, total: 1 },
      sentences: ['one', 'two', 'three'],
      topics: [{ name: topicPath, sentences: [1, 2, 3] }],
    };
    const recordRepository = {
      readRecord: vi.fn(async () => record),
      updateRecord: vi.fn(async (_key, patch) => ({ ...record, ...patch })),
    };
    const pipelineSupervisor = {
      createPipelineRunId: vi.fn(() => 'new-run'),
      cancelActivePipeline: vi.fn(),
      startPipeline: vi.fn(async () => {}),
      clearPipelineFailuresForKey: vi.fn(async () => {}),
    };
    const handlers = createRecordHandlers({
      recordRepository,
      pipelineSupervisor,
      getStoredSummariesDisabled: vi.fn(async () => summariesDisabled),
      summaryCheckpoint: {
        isComplete: vi.fn(() => checkpointComplete),
        isRevisionCurrent: vi.fn(() => true),
      },
    });
    return {
      handlers,
      handler: handlers[MSG.resplitTopic],
      record,
      recordRepository,
      pipelineSupervisor,
    };
  }

  it("persists a canonical path and run range and keeps the record's summary directive", async () => {
    const { handler, record, recordRepository, pipelineSupervisor } = makeResplitHandler({
      // The global toggle must not silently change an existing record.
      summariesDisabled: true,
    });
    // Sentences 2-3 must be one whole card run of the target topic.
    record.topics = [
      { name: 'Intro', sentences: [1] },
      { name: 'Science', sentences: [2, 3] },
    ];
    const response = await handler.handle({
      key: 'topic-record',
      path: ' Science ',
      startSentence: 2,
      endSentence: 3,
    });

    expect(response).toEqual({ ok: true });
    const [key, patch, options] = recordRepository.updateRecord.mock.calls[0];
    expect(key).toBe('topic-record');
    expect(patch).toEqual(
      expect.objectContaining({
        status: 'splitting',
        resplitNotice: null,
        manualResplitIntent: {
          path: 'Science',
          startSentence: 2,
          endSentence: 3,
          previousProgress: { stage: 'done', done: 1, total: 1 },
        },
      }),
    );
    expect(patch).not.toHaveProperty('skipSummaries');
    expect(options).toEqual(expect.objectContaining({ expectedPipelineRunId: 'old-run' }));
    expect(pipelineSupervisor.startPipeline).toHaveBeenCalledWith('topic-record');
  });

  it('rejects an incomplete checkpoint before changing the record', async () => {
    const { handler, recordRepository } = makeResplitHandler({ checkpointComplete: false });
    await expect(
      handler.handle({ key: 'topic-record', path: 'Science', startSentence: 1, endSentence: 2 }),
    ).resolves.toMatchObject({ ok: false });
    expect(recordRepository.updateRecord).not.toHaveBeenCalled();
  });

  it.each(['pending', 'splitting', 'summarizing'])(
    'reports an in-flight %s record as stale',
    async (status) => {
      const { handler, record, recordRepository } = makeResplitHandler();
      record.status = status;

      await expect(handler.handle({ key: record.key })).resolves.toEqual({ ok: true, stale: true });
      expect(recordRepository.updateRecord).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['error', 'retry or reprocess'],
    ['cancelled', 'retry or reprocess'],
    ['needs_attention', 'resolve'],
  ])('explains how to recover a %s record', async (status, guidance) => {
    const { handler, record, recordRepository } = makeResplitHandler();
    record.status = status;

    await expect(handler.handle({ key: record.key })).resolves.toEqual({
      ok: false,
      error: expect.stringContaining(guidance),
    });
    expect(recordRepository.updateRecord).not.toHaveBeenCalled();
  });

  it.each(['error', 'cancelled'])(
    'retries a %s resplit through the existing Retry action',
    async (status) => {
      const { handlers, record, recordRepository } = makeResplitHandler();
      record.status = status;
      record.manualResplitIntent = {
        path: 'Science',
        startSentence: 1,
        endSentence: 2,
      };

      await handlers[MSG.retryRecord].handle({ key: 'topic-record' });

      expect(recordRepository.updateRecord).toHaveBeenCalledWith(
        'topic-record',
        expect.objectContaining({
          status: 'splitting',
          manualResplitIntent: record.manualResplitIntent,
        }),
        expect.anything(),
      );
    },
  );

  it('rejects a card range that no longer matches the saved topics', async () => {
    const { handler, record, recordRepository } = makeResplitHandler();
    record.topics = [
      { name: 'Science', sentences: [1] },
      { name: 'History', sentences: [2, 3] },
    ];

    await expect(
      handler.handle({ key: 'topic-record', path: 'Science', startSentence: 1, endSentence: 2 }),
    ).resolves.toMatchObject({ ok: false, error: expect.stringContaining('stale') });
    expect(recordRepository.updateRecord).not.toHaveBeenCalled();
  });

  it('stopping an in-flight resplit restores the completed record', async () => {
    const { handlers, record, recordRepository, pipelineSupervisor } = makeResplitHandler();
    record.status = 'splitting';
    record.manualResplitIntent = {
      path: 'Science',
      startSentence: 1,
      endSentence: 2,
      previousProgress: { stage: 'done', done: 1, total: 1 },
    };

    await handlers[MSG.cancelRecordProcessing].handle({ key: 'topic-record' });

    expect(recordRepository.updateRecord).toHaveBeenCalledWith(
      'topic-record',
      expect.objectContaining({
        status: 'done',
        error: null,
        manualResplitIntent: null,
        resplitNotice: expect.stringContaining('stopped'),
        progress: { stage: 'done', done: 1, total: 1 },
      }),
      expect.anything(),
    );
    expect(pipelineSupervisor.cancelActivePipeline).toHaveBeenCalled();
  });

  it('stopping an ordinary run still cancels it', async () => {
    const { handlers, record, recordRepository } = makeResplitHandler();
    record.status = 'splitting';

    await handlers[MSG.cancelRecordProcessing].handle({ key: 'topic-record' });

    expect(recordRepository.updateRecord).toHaveBeenCalledWith(
      'topic-record',
      expect.objectContaining({ status: 'cancelled' }),
      expect.anything(),
    );
  });

  it.each([
    ['summarizing', 'old-run', 'cancelled'],
    ['done', 'old-run', 'done'],
    ['summarizing', 'replacement-run', 'summarizing'],
  ])(
    'handles a resplit advancing to %s on %s before Stop commits',
    async (status, pipelineRunId, expectedStatus) => {
      const { handlers, record, recordRepository, pipelineSupervisor } = makeResplitHandler();
      record.status = 'splitting';
      record.manualResplitIntent = {
        path: 'Science',
        startSentence: 1,
        endSentence: 2,
        previousProgress: { stage: 'done', done: 1, total: 1 },
      };
      const replacementTopics = [{ name: 'Physics', sentences: [1, 2, 3] }];
      let stored = record;
      recordRepository.updateRecord.mockImplementation(async (_key, patch, options) => {
        if (stored === record) {
          // The worker commits replacement topics after the handler's read.
          stored = {
            ...record,
            status,
            pipelineRunId,
            manualResplitIntent: null,
            resplitNotice: null,
            topics: replacementTopics,
            topic_summaries: {},
          };
        }
        if (
          options.expectedPipelineRunId !== stored.pipelineRunId ||
          !options.expectedStatuses.includes(stored.status)
        ) {
          return null;
        }
        stored = { ...stored, ...patch };
        return stored;
      });

      const response = await handlers[MSG.cancelRecordProcessing].handle({ key: record.key });

      expect(stored.status).toBe(expectedStatus);
      expect(stored.topics).toEqual(replacementTopics);
      expect(stored.topic_summaries).toEqual({});
      expect(stored.resplitNotice).toBeNull();
      if (expectedStatus === 'cancelled') {
        expect(response).toEqual({ ok: true });
        expect(stored.pipelineRunId).toBe('new-run');
        expect(pipelineSupervisor.cancelActivePipeline).toHaveBeenCalledExactlyOnceWith(
          record.key,
          {
            expectedPipelineRunId: 'old-run',
          },
        );
        expect(pipelineSupervisor.clearPipelineFailuresForKey).toHaveBeenCalledExactlyOnceWith(
          record.key,
        );
      } else {
        expect(response).toEqual({ ok: true, stale: true });
        expect(stored.pipelineRunId).toBe(pipelineRunId);
        expect(pipelineSupervisor.cancelActivePipeline).not.toHaveBeenCalled();
        expect(pipelineSupervisor.clearPipelineFailuresForKey).not.toHaveBeenCalled();
      }
    },
  );

  it('allows replacement of a topic at the maximum depth', async () => {
    const path = 'one>two>three>four>five';
    const { handler, recordRepository } = makeResplitHandler({ topicPath: path });

    await expect(
      handler.handle({
        key: 'topic-record',
        path,
        startSentence: 1,
        endSentence: 3,
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(recordRepository.updateRecord).toHaveBeenCalledOnce();
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
