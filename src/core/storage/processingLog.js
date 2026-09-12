// Buffered processing-log subsystem. Pipeline stages emit diagnostic entries
// far more often than any other write, so they are coalesced in memory and
// flushed as a single diagnostics-document write. This module owns the buffers,
// their debounce timers and their disposal semantics; it shares nothing with
// the record repository beyond the mutation queue and the stale-run guard.
import { getLocal, setLocal, queuedUpdate, MUTATION_QUEUE_KEY } from './primitives.js';
import { recordDiagnosticsStorageKey as diagnosticsStorageKey } from './keys.js';
import { isStaleRun, loadMetaForWrite } from './recordMeta.js';

const MAX_PROCESSING_LOG_ENTRIES = 80;

// Pipeline stages fire a processingLog entry on nearly every LLM request and
// response (see orchestrator.js logPipeline), which used to mean one full
// read-modify-write of the record per entry. Entries are instead buffered in
// memory per record key and flushed as a single write once the buffer has
// been quiet for LOG_FLUSH_DELAY_MS (bounded from the first buffered entry,
// not reset per entry, so a sustained burst still flushes periodically).
//
// These realm-scoped maps share the mutation queue's lifetime so every caller
// coalesces through one buffer. Recycling may lose diagnostics; lifecycle
// disposal below prevents them from landing in the wrong record.
const LOG_FLUSH_DELAY_MS = 250;
/** @type {Map<string, {entries: object[], options: object, disposed?: boolean, deferred: {promise: Promise, resolve: Function, reject: Function}}>} */
const _logBuffers = new Map();
/** @type {Map<string, *>} */
const _logFlushTimers = new Map();
// Buffers that have been detached from _logBuffers (so new entries start a
// fresh buffer) but have not yet written: they are waiting on the mutation and
// key queues. A key can hold more than one, because appendProcessingLog
// detaches a stale run's buffer while the debounce flush of another may still
// be parked. They stay tracked here so disposeProcessingLogs can cancel a flush
// that is queued behind the very delete doing the disposing.
/** @type {Map<string, Set<object>>} */
const _flushingBuffers = new Map();

function createDeferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function trackFlushing(key, buf) {
  let inflight = _flushingBuffers.get(key);
  if (!inflight) {
    inflight = new Set();
    _flushingBuffers.set(key, inflight);
  }
  inflight.add(buf);
}

function untrackFlushing(key, buf) {
  const inflight = _flushingBuffers.get(key);
  if (!inflight) return;
  inflight.delete(buf);
  if (inflight.size === 0) _flushingBuffers.delete(key);
}

async function doFlushProcessingLog(key) {
  const buf = _logBuffers.get(key);
  if (!buf) return null;
  // Detach immediately so later entries start a new buffer under their own
  // run options, but stay cancellable until this flush actually owns the key
  // queue: deleteRecord/deleteAll dispose from inside that same critical
  // section, so a flush parked behind a delete must not write afterwards.
  _logBuffers.delete(key);
  trackFlushing(key, buf);
  const { entries, options } = buf;
  try {
    const result = await queuedUpdate(MUTATION_QUEUE_KEY, () =>
      queuedUpdate(key, async () => {
        if (!_flushingBuffers.get(key)?.has(buf)) return null;
        const meta = await loadMetaForWrite(key);
        if (!meta) return null;
        if (isStaleRun(meta, options)) return null;

        const documentKey = diagnosticsStorageKey(key);
        const diagnostics = (await getLocal(documentKey))[documentKey] || {};
        const existing = Array.isArray(diagnostics.processingLog) ? diagnostics.processingLog : [];
        const processingLog = [...existing, ...entries].slice(-MAX_PROCESSING_LOG_ENTRIES);
        const mergedDiagnostics = { processingLog };

        await setLocal({ [documentKey]: mergedDiagnostics });
        return mergedDiagnostics;
      }),
    );
    // A disposed buffer had its deferred settled by disposeProcessingLogs.
    if (!buf.disposed) buf.deferred.resolve(result);
    return result;
  } catch (err) {
    if (!buf.disposed) buf.deferred.reject(err);
    return null;
  } finally {
    untrackFlushing(key, buf);
  }
}

/**
 * Forces any buffered log entries for `key` to flush immediately, bypassing
 * the debounce timer. Called at pipeline run exit so the final batch of
 * diagnostic entries isn't left stranded if the service worker is recycled
 * shortly after.
 * @param {string} key
 * @returns {Promise<object | null>}
 */
export function flushProcessingLog(key) {
  const timer = _logFlushTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    _logFlushTimers.delete(key);
  }
  if (!_logBuffers.has(key)) return Promise.resolve(null);
  return doFlushProcessingLog(key);
}

/**
 * Discards buffered entries without writing them. Called when the records they
 * describe are being removed: a buffer that outlives its record would otherwise
 * flush after the delete, and entries appended without an
 * `expectedPipelineRunId` bypass the stale-run guard, so a record recreated
 * inside the debounce window could inherit the deleted run's log.
 *
 * Pending `appendProcessingLog` promises resolve with `null` (the same value a
 * flush that finds no meta document produces) rather than rejecting, so
 * discarding cannot turn into an unhandled rejection on a diagnostic path.
 * @param {string} [key] Record key to discard; omit to discard every buffer.
 */
export function disposeProcessingLogs(key) {
  const keys =
    key === undefined
      ? [...new Set([..._logBuffers.keys(), ..._flushingBuffers.keys(), ..._logFlushTimers.keys()])]
      : [key];
  for (const k of keys) {
    const timer = _logFlushTimers.get(k);
    if (timer) {
      clearTimeout(timer);
      _logFlushTimers.delete(k);
    }
    const buf = _logBuffers.get(k);
    if (buf) {
      _logBuffers.delete(k);
      buf.disposed = true;
      buf.deferred.resolve(null);
    }
    // Cancel detached buffers too: a flush waiting on the mutation or key
    // queue would otherwise resume after the caller's delete and write into a
    // record that no longer exists (or was recreated in the meantime).
    for (const inflight of _flushingBuffers.get(k) ?? []) {
      inflight.disposed = true;
      inflight.deferred.resolve(null);
    }
    _flushingBuffers.delete(k);
  }
}

/**
 * @param {string} key
 * @param {string} stage
 * @param {Record<string, unknown>} [details]
 * @param {object} [options]  Identifies the pipeline
 *   run this entry belongs to; a buffer whose entries were queued under a
 *   different run id is treated as stale and flushed before this entry starts
 *   a new buffer under `options`.
 * @param {unknown} [options.expectedPipelineRunId]
 * @returns {Promise<object | null>}
 */
export function appendProcessingLog(key, stage, details = {}, options = {}) {
  const entry = { at: new Date().toISOString(), stage, details };
  const stale = _logBuffers.get(key);
  if (stale && stale.options.expectedPipelineRunId !== options.expectedPipelineRunId) {
    // A new pipeline run (retry/reprocess) started for this record before the
    // previous run's buffered entries flushed. Flush the stale buffer now,
    // under its own run id, instead of letting its entries ride along on this
    // call's options — otherwise they'd bypass the stale-run guard in
    // doFlushProcessingLog and get written in under the new run's identity.
    void flushProcessingLog(key);
  }
  let buf = _logBuffers.get(key);
  if (!buf) {
    buf = { entries: [], options, deferred: createDeferred() };
    _logBuffers.set(key, buf);
  }
  buf.entries.push(entry);
  buf.options = options;
  if (!_logFlushTimers.has(key)) {
    const timer = setTimeout(() => {
      _logFlushTimers.delete(key);
      void doFlushProcessingLog(key);
    }, LOG_FLUSH_DELAY_MS);
    _logFlushTimers.set(key, timer);
  }
  return buf.deferred.promise;
}
