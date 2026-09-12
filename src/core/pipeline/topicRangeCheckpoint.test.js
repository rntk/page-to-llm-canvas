import { describe, expect, it, vi } from 'vitest';
import {
  readTopicRangeChunkCheckpoint,
  saveTopicRangeChunkCheckpoint,
} from './topicRangeCheckpoint.js';

const chunks = [
  { start: 0, sentenceCount: 2, tagged: '{0} A\n{1} B' },
  { start: 2, sentenceCount: 1, tagged: '{0} C' },
];
const segments = [{ label: ['Topic'], start: 0, end: 1 }];

function checkpoint(overrides = {}) {
  return {
    contentRevision: 'rev-1',
    sentenceCount: 3,
    chunks: [{ start: 0, sentenceCount: 2, segments }, null],
    ...overrides,
  };
}

function record(value = checkpoint()) {
  return { contentRevision: 'rev-1', topic_range_chunks: value };
}

describe('readTopicRangeChunkCheckpoint', () => {
  it('restores completed chunks and leaves pending chunks null', () => {
    expect(readTopicRangeChunkCheckpoint(record(), chunks)).toEqual({
      segments: [segments, null],
      reusedChunkCount: 1,
    });
  });

  it.each([
    ['a non-object payload', 'invalid'],
    ['a revision mismatch', checkpoint({ contentRevision: 'rev-other' })],
    ['a sentence-count mismatch', checkpoint({ sentenceCount: 2 })],
    ['a chunk-count mismatch', checkpoint({ chunks: [null] })],
    [
      'a chunk-boundary mismatch',
      checkpoint({ chunks: [{ start: 1, sentenceCount: 2, segments }, null] }),
    ],
    [
      'an empty completed chunk',
      checkpoint({ chunks: [{ start: 0, sentenceCount: 2, segments: [] }, null] }),
    ],
    [
      'a malformed label',
      checkpoint({
        chunks: [
          { start: 0, sentenceCount: 2, segments: [{ label: [''], start: 0, end: 1 }] },
          null,
        ],
      }),
    ],
    [
      'an out-of-bounds segment',
      checkpoint({
        chunks: [
          { start: 0, sentenceCount: 2, segments: [{ label: ['Topic'], start: 0, end: 2 }] },
          null,
        ],
      }),
    ],
    ['no completed chunks', checkpoint({ chunks: [null, null] })],
  ])('rejects untrusted JSON containing %s', (_label, value) => {
    expect(readTopicRangeChunkCheckpoint(record(value), chunks)).toBeNull();
  });

  it('rejects checkpoints that cannot be pinned to a content revision', () => {
    expect(readTopicRangeChunkCheckpoint({ topic_range_chunks: checkpoint() }, chunks)).toBeNull();
  });
});

describe('saveTopicRangeChunkCheckpoint', () => {
  it('persists only completed chunk state', async () => {
    const runtime = { update: vi.fn(), log: vi.fn() };
    const chunkStates = [
      { chunk: chunks[0], segments },
      { chunk: chunks[1], segments: null },
    ];

    await saveTopicRangeChunkCheckpoint(runtime, record(), chunkStates, 3);

    expect(runtime.update).toHaveBeenCalledWith({ topic_range_chunks: checkpoint() });
    expect(runtime.log).toHaveBeenCalledWith(
      'topic_ranges_checkpoint_saved',
      { completedChunkCount: 1, chunkCount: 2 },
      { allowAborted: true },
    );
  });

  it('does not write a checkpoint without a revision or completed chunk', async () => {
    const runtime = { update: vi.fn(), log: vi.fn() };
    await saveTopicRangeChunkCheckpoint(runtime, {}, [{ chunk: chunks[0], segments }], 2);
    await saveTopicRangeChunkCheckpoint(
      runtime,
      { contentRevision: 'rev-1' },
      [{ chunk: chunks[0], segments: null }],
      2,
    );
    expect(runtime.update).not.toHaveBeenCalled();
  });
});
