import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({
  appendProcessingLog: vi.fn(() => Promise.resolve()),
  flushProcessingLog: vi.fn(() => Promise.resolve()),
  readRecord: vi.fn(async () => ({ key: 'record-1' })),
  updateRecord: vi.fn(async (_key, patch) => ({ key: 'record-1', ...patch })),
}));

vi.mock('../storage/storage.js', () => storage);

import { isCancellationError } from './cancellation.js';
import { createPipelineRuntime, formatPipelineError } from './pipelineRuntime.js';
import { MAX_TAGGED_CHARS, TOPIC_RANGE_INPUT_MAX_SENTENCES } from './pipelineConfig.js';

describe('formatPipelineError', () => {
  it('handles missing errors and preserves a message already present in a stack', () => {
    expect(formatPipelineError(null)).toBe('Unknown error');
    expect(formatPipelineError('plain failure')).toBe('plain failure');
    expect(formatPipelineError({ message: 'failed', stack: 'Error: failed\n at test' })).toBe(
      'Error: failed\n at test',
    );
    expect(formatPipelineError({ message: 'failed', stack: 'at test' })).toBe('failed\nat test');
    expect(formatPipelineError({ message: 'failed', stack: 123 })).toBe('failed');
  });
});

describe('createPipelineRuntime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('guards reads and updates with the current pipeline run', async () => {
    const runtime = createPipelineRuntime({
      key: 'record-1',
      pipelineRunId: 'run-7',
      preferContentLanguage: true,
    });

    await expect(runtime.read()).resolves.toEqual({ key: 'record-1' });
    await expect(runtime.update({ status: 'done' })).resolves.toEqual({
      key: 'record-1',
      status: 'done',
    });
    expect(storage.readRecord).toHaveBeenCalledWith('record-1');
    expect(storage.updateRecord).toHaveBeenCalledWith(
      'record-1',
      { status: 'done' },
      { expectedPipelineRunId: 'run-7' },
    );
  });

  it('turns a superseded update and cancellation into AbortErrors', async () => {
    storage.updateRecord.mockResolvedValueOnce(null);
    const runtime = createPipelineRuntime({ key: 'record-1', pipelineRunId: 'run-7' });

    const superseded = await runtime.update({ status: 'done' }).catch((error) => error);
    expect(superseded).toMatchObject({
      name: 'AbortError',
      message: 'Pipeline run is no longer current',
    });
    // Losing the record to a newer run never aborts this run's signal, so the
    // marker is the only thing that keeps it classified as cancellation.
    expect(runtime.signal?.aborted).toBeUndefined();
    expect(isCancellationError(superseded, runtime)).toBe(true);

    const controller = new AbortController();
    controller.abort();
    const cancelled = createPipelineRuntime({ key: 'record-1', signal: controller.signal });
    expect(() => cancelled.assertActive()).toThrow(
      expect.objectContaining({ name: 'AbortError', message: 'Pipeline run was cancelled' }),
    );
    await expect(cancelled.read()).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('stores the summaries-disabled flag as a strict boolean', () => {
    const runtime = createPipelineRuntime({ key: 'record-1', summariesDisabled: true });
    expect(runtime.summariesDisabled).toBe(true);
    runtime.setSummariesDisabled('true');
    expect(runtime.summariesDisabled).toBe(false);
    runtime.setSummariesDisabled(true);
    expect(runtime.summariesDisabled).toBe(true);
  });

  it('defaults summariesDisabled to false', () => {
    expect(createPipelineRuntime({ key: 'record-1' }).summariesDisabled).toBe(false);
  });

  it('owns default and overridden chunk limits', () => {
    expect(createPipelineRuntime({ key: 'record-1' })).toMatchObject({
      maxTextChunkChars: MAX_TAGGED_CHARS,
      maxTopicRangeSentences: TOPIC_RANGE_INPUT_MAX_SENTENCES,
    });
    expect(
      createPipelineRuntime({
        key: 'record-1',
        maxTextChunkChars: 12000,
        maxTopicRangeSentences: 80,
      }),
    ).toMatchObject({
      maxTextChunkChars: 12000,
      maxTopicRangeSentences: 80,
    });
  });

  it('suppresses verbose logs while always recording normal logs', async () => {
    const runtime = createPipelineRuntime({ key: 'record-1', pipelineRunId: 'run-7' });

    await runtime.log('hidden', { value: 1 }, { verbose: true });
    expect(storage.appendProcessingLog).not.toHaveBeenCalled();
    expect(console.info).not.toHaveBeenCalled();

    await runtime.log('visible', { value: 2 });
    expect(console.info).toHaveBeenCalledWith('PageToLLM Canvas pipeline:', 'visible', {
      value: 2,
    });
    expect(storage.appendProcessingLog).toHaveBeenCalledWith(
      'record-1',
      'visible',
      { value: 2 },
      { expectedPipelineRunId: 'run-7' },
    );
  });

  it('does not reject when buffered logging or flushing fails', async () => {
    storage.appendProcessingLog.mockRejectedValueOnce(new Error('write failed'));
    storage.flushProcessingLog.mockRejectedValueOnce(new Error('flush failed'));
    const runtime = createPipelineRuntime({ key: 'record-1' });

    await expect(runtime.log('stage')).resolves.toBeUndefined();
    await Promise.resolve();
    expect(console.warn).toHaveBeenCalledWith(
      'PageToLLM Canvas pipeline log failed:',
      expect.objectContaining({ message: 'write failed' }),
    );
    await expect(runtime.flushLogs()).resolves.toBeUndefined();
    expect(storage.flushProcessingLog).toHaveBeenCalledWith('record-1');
  });

  it('waits for the processing-log flush to settle', async () => {
    let resolveFlush;
    storage.flushProcessingLog.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFlush = resolve;
        }),
    );
    const runtime = createPipelineRuntime({ key: 'record-1' });
    let settled = false;
    const pending = runtime.flushLogs().then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    resolveFlush();
    await pending;
    expect(settled).toBe(true);
  });
});
