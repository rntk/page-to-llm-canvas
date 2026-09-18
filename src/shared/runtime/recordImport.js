// The single decoder for user-supplied import payloads. The options page and
// the service worker used to each trim keys, coerce in-flight status, clear
// errors and stamp `imported` progress by hand, and had already drifted (the UI
// stamped `importedAt`; the worker persisted whatever the caller sent). The
// worker is the authority: it always runs this over the raw payload it
// receives. The UI may run it too, but only as a preview (dedupe/collision
// checks); nothing it produces is trusted by the worker.
//
// Runtime-owned fields (`pipelineRunId`, content-revision bumps, cancelling an
// active run) are deliberately NOT set here — they belong to the worker.
//
// Unknown fields are kept on purpose: `isImportableRecord` is the only schema
// exports have ever had to satisfy, and storage files everything it does not
// recognise under meta (see `pickMetaFields` in src/core/storage/storage.js),
// so older exports keep round-tripping unchanged.
import {
  isImportableRecord,
  isInFlightPipelineStatus,
  PIPELINE_STAGE,
  PIPELINE_STATUS,
} from './contracts.js';
import { progressAt } from './recordTransitions.js';

/**
 * Accepts either a single record object or an array of them.
 * @param {unknown} payload
 * @returns {Array<object>}
 */
export function extractImportedRecords(payload) {
  if (Array.isArray(payload)) return payload.filter((item) => item && typeof item === 'object');
  if (!payload || typeof payload !== 'object') return [];
  return [payload];
}

/**
 * Normalizes one importable record into a storage-ready record that is
 * immediately viewable and cannot resume the LLM pipeline.
 *
 * @param {object} record Must satisfy `isImportableRecord`.
 * @param {{now?: number}} [options]
 * @returns {object}
 */
export function normalizeImportedRecord(record, { now = Date.now() } = {}) {
  const key = record.key.trim();
  const status = isInFlightPipelineStatus(record.status)
    ? PIPELINE_STATUS.DONE
    : record.status || PIPELINE_STATUS.DONE;
  return {
    ...record,
    key,
    status,
    error: status === PIPELINE_STATUS.DONE ? null : record.error || null,
    progress: {
      ...(record.progress && typeof record.progress === 'object' ? record.progress : {}),
      ...progressAt(PIPELINE_STAGE.IMPORTED, 1, 1),
    },
    importedAt: now,
  };
}

/**
 * Decodes a raw import payload: extracts records, drops anything that is not
 * importable, dedupes by trimmed key (later entries win, since they are the
 * values that would overwrite earlier ones in storage anyway) and normalizes
 * the survivors.
 *
 * @param {unknown} payload
 * @param {{now?: number}} [options]
 * @returns {Array<object>}
 */
export function decodeImportedRecords(payload, options = {}) {
  const byKey = new Map();
  for (const record of extractImportedRecords(payload)) {
    if (isImportableRecord(record)) byKey.set(record.key.trim(), record);
  }
  return Array.from(byKey.values(), (record) => normalizeImportedRecord(record, options));
}
