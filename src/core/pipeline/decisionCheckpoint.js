import { rethrowIfCancelled, throwIfCancelled } from './cancellation.js';

// Increase when boundary/label semantics or the checkpoint schema changes.
export const DECISION_CHECKPOINT_VERSION = 1;

/**
 * Create a validated, serialized checkpoint writer using the existing topic
 * work document. Source and policy identities prevent stale imported work from
 * being reused. Successful gaps and labels survive retries and worker restarts.
 * Supply the parent runtime: sibling request cancellation must not discard
 * completed saves; user cancellation and lost ownership still stop writes.
 * @param {object} input Runtime, record, source text, and request policy.
 */
export async function createDecisionCheckpoint({ runtime, record, text, policy }) {
  if (typeof record.contentRevision !== 'string' || !record.contentRevision) {
    return { probabilities: {}, labels: {}, save: async () => {} };
  }
  const bytes = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  const source = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  const identity = JSON.stringify([DECISION_CHECKPOINT_VERSION, source, policy]);
  const stored = record.topic_range_chunks;
  const revision = record.contentRevision;
  const validProbability = (value) => Number.isFinite(value) && value >= 0 && value <= 1;
  const validLabel = (value) =>
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((part) => typeof part === 'string' && part.trim());
  const reusable =
    stored?.mode === 'decision' &&
    stored.contentRevision === revision &&
    stored.identity === identity &&
    stored.probabilities &&
    typeof stored.probabilities === 'object' &&
    !Array.isArray(stored.probabilities) &&
    Object.entries(stored.probabilities).every(
      ([key, value]) =>
        /^b[1-9]\d*$/.test(key) && Number(key.slice(1)) >= 2 && validProbability(value),
    ) &&
    stored.labels &&
    typeof stored.labels === 'object' &&
    !Array.isArray(stored.labels) &&
    Object.entries(stored.labels).every(
      ([key, value]) => /^\d+:\d+$/.test(key) && validLabel(value),
    );
  const probabilities = reusable ? { ...stored.probabilities } : {};
  const labels = reusable ? structuredClone(stored.labels) : {};
  if (reusable) {
    await runtime.log('topic_ranges_checkpoint_reused', {
      gapCount: Object.keys(probabilities).length,
      labelCount: Object.keys(labels).length,
    });
  }
  let writes = Promise.resolve();
  const save = () => {
    // Snapshot at submission time; serialize writes so a slower earlier write
    // cannot overwrite a newer snapshot from another completed batch.
    const checkpoint = structuredClone({
      mode: 'decision',
      contentRevision: revision,
      identity,
      probabilities,
      labels,
    });
    const next = writes.then(async () => {
      throwIfCancelled(runtime);
      try {
        await runtime.update({ topic_range_chunks: checkpoint });
      } catch (error) {
        rethrowIfCancelled(error, runtime);
        await runtime
          .log('topic_ranges_checkpoint_save_failed', {
            error: String(error?.message ?? error),
          })
          .catch(() => {});
      }
    });
    writes = next.catch(() => {});
    return next;
  };
  return { probabilities, labels, save };
}
