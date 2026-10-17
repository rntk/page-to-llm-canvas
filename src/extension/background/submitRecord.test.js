import { describe, expect, it, vi } from 'vitest';
import { createSubmitRecord } from './submitRecord.js';

function setup(existing = null) {
  const recordRepository = {
    findRecordByUrl: vi.fn(async () => existing),
    readRecord: vi.fn(async () => existing),
    writeRecord: vi.fn(async () => true),
    updateRecord: vi.fn(async () => true),
  };
  const pipelineSupervisor = {
    isActive: vi.fn(() => false),
    createPipelineRunId: vi.fn(() => 'run-new'),
    startPipeline: vi.fn(async () => {}),
  };
  return {
    recordRepository,
    pipelineSupervisor,
    submit: createSubmitRecord({
      recordRepository,
      pipelineSupervisor,
      getStoredSummariesDisabled: async () => false,
      hashContent: async () => 'content-key',
      clock: () => 123,
    }),
  };
}

const capture = {
  html: '<p>ABC grew. XYZ declined.</p>',
  sourceUrl: 'https://example.test/stocks',
  captureVersion: 2,
  capturedText: 'ABC grew. XYZ declined.',
};

describe('custom instructions on submission', () => {
  it('saves normalized instructions with new articles', async () => {
    const { submit, recordRepository } = setup();
    await submit({
      ...capture,
      splittingInstructions: ' Split by company. ',
      summaryInstructions: ' Focus on ABC. ',
    });
    expect(recordRepository.writeRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        splittingInstructions: 'Split by company.',
        summaryInstructions: 'Focus on ABC.',
      }),
      { onlyIfAbsent: true },
    );
  });

  it.each(['splittingInstructions', 'summaryInstructions'])(
    'reruns unchanged article text when %s changes or is cleared',
    async (field) => {
      for (const value of ['Focus on XYZ.', '']) {
        const { submit, recordRepository, pipelineSupervisor } = setup({
          ...capture,
          key: 'saved',
          pipelineRunId: 'run-old',
          status: 'done',
          [field]: 'Focus on ABC.',
          topics: [{ name: 'Old', sentences: [1] }],
        });
        await submit({ ...capture, [field]: value });
        expect(recordRepository.updateRecord).toHaveBeenCalledWith(
          'saved',
          expect.objectContaining({
            [field]: value,
            status: 'pending',
            topics: [],
          }),
          expect.objectContaining({ bumpContentRevision: true }),
        );
        expect(pipelineSupervisor.startPipeline).toHaveBeenCalledWith('saved');
      }
    },
  );

  it('reuses completed results when text and normalized instructions match', async () => {
    const { submit, pipelineSupervisor } = setup({
      ...capture,
      key: 'saved',
      pipelineRunId: 'run-old',
      status: 'done',
      summaryInstructions: 'Focus on ABC.',
    });
    await submit({ ...capture, summaryInstructions: '  Focus on ABC.  ' });
    expect(pipelineSupervisor.startPipeline).not.toHaveBeenCalled();
  });
});
