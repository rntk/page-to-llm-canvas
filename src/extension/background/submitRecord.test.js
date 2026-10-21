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
  it('persists normalized instructions as a run directive on new articles', async () => {
    const { submit, recordRepository, pipelineSupervisor } = setup();
    await submit({
      ...capture,
      splittingInstructions: ' Split by company. ',
      summaryInstructions: ' Focus on ABC. ',
    });
    const record = recordRepository.writeRecord.mock.calls[0][0];
    expect(record.runInstructions).toEqual({
      splittingInstructions: 'Split by company.',
      summaryInstructions: 'Focus on ABC.',
    });
    expect(record).not.toHaveProperty('splittingInstructions');
    expect(record).not.toHaveProperty('summaryInstructions');
    expect(pipelineSupervisor.startPipeline).toHaveBeenCalledWith('content-key');
  });

  it('stores no run instructions for an unguided submission', async () => {
    const { submit, recordRepository } = setup();
    await submit({ ...capture, summaryInstructions: '  ' });
    expect(recordRepository.writeRecord.mock.calls[0][0].runInstructions).toBeNull();
  });

  it.each(['splittingInstructions', 'summaryInstructions'])(
    'reruns unchanged article text with run-scoped %s',
    async (field) => {
      const { submit, recordRepository, pipelineSupervisor } = setup({
        ...capture,
        key: 'saved',
        pipelineRunId: 'run-old',
        status: 'done',
        topics: [{ name: 'Old', sentences: [1] }],
      });
      await submit({ ...capture, [field]: 'Focus on XYZ.' });
      const patch = recordRepository.updateRecord.mock.calls[0][1];
      expect(patch).toMatchObject({ status: 'pending', topics: [] });
      expect(patch.runInstructions).toMatchObject({ [field]: 'Focus on XYZ.' });
      expect(patch).not.toHaveProperty('splittingInstructions');
      expect(patch).not.toHaveProperty('summaryInstructions');
      expect(pipelineSupervisor.startPipeline).toHaveBeenCalledWith('saved');
    },
  );

  it('reuses completed results when text matches and no instructions are supplied', async () => {
    const { submit, pipelineSupervisor } = setup({
      ...capture,
      key: 'saved',
      pipelineRunId: 'run-old',
      status: 'done',
    });
    await submit({ ...capture, summaryInstructions: '  ' });
    expect(pipelineSupervisor.startPipeline).not.toHaveBeenCalled();
  });
});
