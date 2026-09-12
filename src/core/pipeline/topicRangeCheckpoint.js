import { isCancellationError, rethrowIfCancelled } from './cancellation.js';

export const TOPIC_RANGE_ABORT_MESSAGE = 'pipeline aborted during topic ranging';

/**
 * Validate and restore a topic-range checkpoint for the current chunks.
 * Validation is deliberately all-or-nothing: imported record fields are
 * untrusted JSON, and this checkpoint is only a cost optimization.
 * @param {object} record Record snapshot read at pipeline start.
 * @param {object[]} chunks Chunks derived from the current sentences.
 */
export function readTopicRangeChunkCheckpoint(record, chunks) {
  const checkpoint = record?.topic_range_chunks;
  if (!checkpoint || typeof checkpoint !== 'object') return null;
  if (!Array.isArray(chunks) || chunks.length === 0) return null;
  if (!Array.isArray(checkpoint.chunks) || checkpoint.chunks.length !== chunks.length) return null;
  const revision = record?.contentRevision;
  if (typeof revision !== 'string' || !revision) return null;
  if (checkpoint.contentRevision !== revision) return null;
  const sentenceCount = chunks.reduce((sum, chunk) => sum + chunk.sentenceCount, 0);
  if (checkpoint.sentenceCount !== sentenceCount) return null;

  const segments = new Array(chunks.length).fill(null);
  let reusedChunkCount = 0;
  for (let index = 0; index < chunks.length; index++) {
    const entry = checkpoint.chunks[index];
    if (entry == null) continue;
    if (typeof entry !== 'object') return null;
    const chunk = chunks[index];
    if (entry.start !== chunk.start || entry.sentenceCount !== chunk.sentenceCount) return null;
    // Completed chunks always contain at least one parsed segment. Accepting
    // an empty array would incorrectly mark a chunk done forever.
    if (!Array.isArray(entry.segments) || entry.segments.length === 0) return null;
    const lastSentence = chunk.start + chunk.sentenceCount - 1;
    const restored = [];
    for (const segment of entry.segments) {
      if (!segment || typeof segment !== 'object') return null;
      const { label, start, end } = segment;
      if (!Array.isArray(label) || label.length === 0) return null;
      if (!label.every((part) => typeof part === 'string' && part.trim() !== '')) return null;
      if (!Number.isInteger(start) || !Number.isInteger(end) || start > end) return null;
      if (start < chunk.start || end > lastSentence) return null;
      restored.push({ label: [...label], start, end });
    }
    segments[index] = restored;
    reusedChunkCount++;
  }
  return reusedChunkCount === 0 ? null : { segments, reusedChunkCount };
}

function buildTopicRangeChunkCheckpoint(contentRevision, chunkStates, sentenceCount) {
  return {
    contentRevision,
    sentenceCount,
    chunks: chunkStates.map((state) =>
      state.segments === null
        ? null
        : {
            start: state.chunk.start,
            sentenceCount: state.chunk.sentenceCount,
            segments: state.segments,
          },
    ),
  };
}

/**
 * Best-effort checkpoint persistence; ownership/cancellation failures
 * propagate so a superseded pipeline cannot continue writing.
 * @param {object} runtime Pipeline runtime.
 * @param {object} record Record snapshot read at pipeline start.
 * @param {object[]} chunkStates Per-chunk stage state.
 * @param {number} sentenceCount Total sentence count.
 * @param {unknown} [error] Error that ended the stage.
 */
export async function saveTopicRangeChunkCheckpoint(
  runtime,
  record,
  chunkStates,
  sentenceCount,
  error,
) {
  // Partial work from a cancelled run belongs to a superseded attempt.
  if (isCancellationError(error, runtime)) return;
  const contentRevision = record?.contentRevision;
  if (typeof contentRevision !== 'string' || !contentRevision) return;
  const done = chunkStates.filter((state) => state.segments !== null).length;
  if (done === 0) return;
  try {
    await runtime.update({
      topic_range_chunks: buildTopicRangeChunkCheckpoint(
        contentRevision,
        chunkStates,
        sentenceCount,
      ),
    });
    // The write already landed, so a racing abort must not turn this log into a
    // reported checkpoint failure.
    await runtime.log(
      'topic_ranges_checkpoint_saved',
      { completedChunkCount: done, chunkCount: chunkStates.length },
      { allowAborted: true },
    );
  } catch (writeError) {
    // A lost run-id CAS is an ownership failure, not a best-effort storage
    // failure, and must stop the retry loop.
    rethrowIfCancelled(writeError, runtime, TOPIC_RANGE_ABORT_MESSAGE);
    await runtime
      .log(
        'topic_ranges_checkpoint_save_failed',
        { error: (writeError && writeError.message) || String(writeError) },
        { allowAborted: true },
      )
      .catch(() => {
        /* The stage error is the one that matters. */
      });
  }
}
