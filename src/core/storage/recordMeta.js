// Record-level metadata primitives: the small `:meta` document every record
// write goes through, the schema-version guards that decide whether a stored
// document is still readable (or belongs to a newer build and must be kept), and the snippet derivation the index projection
// caches. Kept below the index, log and reconciliation modules so all three can
// share them without importing each other.
import { getLocal } from './primitives.js';
import { recordMetaStorageKey as metaStorageKey } from './keys.js';

export const RECORD_STORAGE_PREFIX = 'pagetollm:rec:';
export const RECORD_STORAGE_SCHEMA_VERSION = 2;
const RECORD_SNIPPET_MAX_CHARS = 500;

export function hasOwn(obj, field) {
  return Object.prototype.hasOwnProperty.call(obj, field);
}

export function isRecordMeta(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function isCurrentRecordMeta(value) {
  return isRecordMeta(value) && value.storageSchemaVersion === RECORD_STORAGE_SCHEMA_VERSION;
}

/**
 * A meta doc written by a newer build (e.g. before an extension downgrade).
 * This build cannot read it, but must never delete or overwrite it: the newer
 * build owns it again after the next upgrade.
 * @param {unknown} value Stored meta document.
 */
export function isFutureRecordMeta(value) {
  return (
    isRecordMeta(value) &&
    Number.isInteger(value.storageSchemaVersion) &&
    value.storageSchemaVersion > RECORD_STORAGE_SCHEMA_VERSION
  );
}

/**
 * Loads a record's meta doc for a write path (updateRecord / log flush).
 * Only reads the small meta doc — the whole point of the split, since this
 * runs on nearly every pipeline step. Returns `null` if the record does not
 * exist.
 * @param {string} key Record key.
 */
export async function loadMetaForWrite(key) {
  const metaKey = metaStorageKey(key);
  const items = await getLocal(metaKey);
  const meta = items[metaKey];
  return isCurrentRecordMeta(meta) ? meta : null;
}

export function createContentRevision() {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid
    ? `rev_${uuid}`
    : `rev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

export function isStaleRun(meta, options) {
  if (
    hasOwn(options, 'expectedPipelineRunId') &&
    meta.pipelineRunId !== options.expectedPipelineRunId
  ) {
    return true;
  }
  return (
    hasOwn(options, 'expectedStatuses') &&
    (!Array.isArray(options.expectedStatuses) || !options.expectedStatuses.includes(meta.status))
  );
}

export function buildRecordSnippet(record) {
  const text = String((record && record.text) || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= RECORD_SNIPPET_MAX_CHARS) return text;
  return `${text.slice(0, RECORD_SNIPPET_MAX_CHARS).trimEnd()}...`;
}
