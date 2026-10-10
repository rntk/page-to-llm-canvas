import { describe, it, expect, vi } from 'vitest';
import { createDecisionCheckpoint } from './decisionCheckpoint.js';
import { makeRuntime } from '../../../test/fakes/pipelineFixtures.mjs';

const input = (runtime, record = {}) => ({
  runtime,
  record: { contentRevision: 'rev1', ...record },
  text: 'Article',
  policy: ['model', 'prompt'],
});

describe('decision checkpoint', () => {
  it('reuses saved work only for matching source, revision, policy, and valid data', async () => {
    const runtime = makeRuntime();
    const checkpoint = await createDecisionCheckpoint(input(runtime));
    checkpoint.probabilities.b2 = 0.9;
    checkpoint.labels['0:0'] = ['Topic'];
    await checkpoint.save();
    const stored = runtime.update.mock.calls[0][0].topic_range_chunks;
    const record = { topic_range_chunks: stored };
    expect((await createDecisionCheckpoint(input(runtime, record))).probabilities).toEqual({
      b2: 0.9,
    });
    for (const overrides of [
      { text: 'Other article' },
      { policy: ['other model'] },
      { record: { ...record, contentRevision: 'rev2' } },
      {
        record: {
          ...record,
          contentRevision: 'rev1',
          topic_range_chunks: { ...stored, probabilities: { b2: NaN } },
        },
      },
      {
        record: {
          ...record,
          contentRevision: 'rev1',
          topic_range_chunks: { ...stored, labels: { '0:0': [] } },
        },
      },
    ]) {
      const restored = await createDecisionCheckpoint({ ...input(runtime, record), ...overrides });
      expect(restored.probabilities).toEqual({});
      expect(restored.labels).toEqual({});
    }
  });

  it('serializes snapshots from concurrently completed batches', async () => {
    let release;
    const runtime = makeRuntime({
      update: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              release = resolve;
            }),
        )
        .mockResolvedValue(undefined),
    });
    const checkpoint = await createDecisionCheckpoint(input(runtime));
    checkpoint.probabilities.b2 = 0.1;
    const first = checkpoint.save();
    checkpoint.probabilities.b3 = 0.9;
    const second = checkpoint.save();
    await vi.waitFor(() => expect(runtime.update).toHaveBeenCalledTimes(1));
    expect(runtime.update.mock.calls[0][0].topic_range_chunks.probabilities).toEqual({ b2: 0.1 });
    release();
    await Promise.all([first, second]);
    expect(runtime.update.mock.calls[1][0].topic_range_chunks.probabilities).toEqual({
      b2: 0.1,
      b3: 0.9,
    });
  });

  it('treats storage failure as best effort but propagates lost ownership', async () => {
    const runtime = makeRuntime({ update: vi.fn().mockRejectedValue(new Error('quota')) });
    const checkpoint = await createDecisionCheckpoint(input(runtime));
    await checkpoint.save();
    expect(runtime.log).toHaveBeenCalledWith(
      'topic_ranges_checkpoint_save_failed',
      expect.any(Object),
    );
    const { markCancellation } = await import('./cancellation.js');
    const superseded = markCancellation(new Error('superseded'));
    runtime.update.mockRejectedValue(superseded);
    await expect(checkpoint.save()).rejects.toMatchObject({ name: 'AbortError' });
  });
});

it('does not persist queued checkpoints after parent run cancellation', async () => {
  const controller = new AbortController();
  let release;
  const runtime = makeRuntime({
    signal: controller.signal,
    update: vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValue(undefined),
  });
  const checkpoint = await createDecisionCheckpoint(input(runtime));
  checkpoint.probabilities.b2 = 0;
  const first = checkpoint.save();
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  checkpoint.probabilities.b3 = 1;
  const second = checkpoint.save();
  const rejected = expect(second).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort();
  release();
  await first;
  await rejected;
  expect(runtime.update).toHaveBeenCalledTimes(1);
});
