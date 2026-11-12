// Decode user-supplied records in both UI previews and the authoritative worker
// import path. Worker-owned run and revision fields are set later. Preserve
// unknown fields so older exports round-trip through record meta.
import { isImportableRecord, PIPELINE_STAGE, PIPELINE_STATUS } from './contracts.js';
import { progressAt } from './recordTransitions.js';
import { SUMMARY_TREE_STATUS } from './summaryTree.js';

// Statuses an imported record may keep. Anything else (in-flight or unknown)
// would be shown as in progress forever, since nothing is running for it.
const IMPORTABLE_TERMINAL_STATUSES = new Set([
  PIPELINE_STATUS.DONE,
  PIPELINE_STATUS.ERROR,
  PIPELINE_STATUS.CANCELLED,
  PIPELINE_STATUS.NEEDS_ATTENTION,
]);

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
  const status = IMPORTABLE_TERMINAL_STATUSES.has(record.status)
    ? record.status
    : PIPELINE_STATUS.DONE;
  // No build is running for an imported tree, so a running one must not be
  // resumable (or auto-recovered).
  const tree = record.summary_tree;
  const summaryTree =
    tree && typeof tree === 'object' && tree.status === SUMMARY_TREE_STATUS.RUNNING
      ? {
          ...tree,
          status: SUMMARY_TREE_STATUS.CANCELLED,
          backgroundRecovery: false,
          error: tree.error || 'Stopped.',
        }
      : tree;
  return {
    ...record,
    ...(summaryTree === tree ? {} : { summary_tree: summaryTree }),
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
