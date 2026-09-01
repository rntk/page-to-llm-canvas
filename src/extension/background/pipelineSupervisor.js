import { formatPipelineError } from '../../../worker/pipeline/pipelineRuntime.js';
import { isInFlightRecord, isInFlightStatus } from '../../../worker/pipeline/pipelineStatus.js';
import { PIPELINE_STATUS } from '../../shared/runtime/contracts.js';
import { createLogger } from '../../shared/runtime/log.js';

/** Alarm name used to keep the service worker alive while pipelines are running. */
export const KEEPALIVE_ALARM = 'pipeline-keepalive';
/** Chrome MV3 enforces a minimum of 30 s (0.5 min) for alarm periods. */
const KEEPALIVE_PERIOD_MINUTES = 0.5;

function defaultIdFactory() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Owns everything about *running* pipelines: the in-memory job registry, the
 * keepalive alarm, and storage-driven recovery of orphaned runs.
 *
 * Every browser touchpoint arrives through `alarms` and `runtime`, so this
 * module can be constructed and exercised without a `chrome` global. Callers
 * that do run in the worker pass thin accessors that read `chrome.*` at call
 * time (see background.js) — binding `chrome.alarms` eagerly would capture a
 * stale namespace object.
 *
 * @param {object} deps
 * @param {{readRecord: Function, updateRecord: Function, listRecords: Function}} deps.recordRepository
 * @param {Function} deps.runPipeline
 * @param {{get: Function, create: Function, clear: Function, onAlarm?: object}} deps.alarms
 * @param {{lastError: *}} deps.runtime Carries `lastError`; read per access.
 * @param {function(): number} [deps.clock]
 * @param {function(): string} [deps.idFactory]
 * @param {object} [deps.logger] Base logger; scoped children are derived here.
 */
export function createPipelineSupervisor({
  recordRepository,
  runPipeline,
  alarms,
  runtime,
  clock = Date.now,
  idFactory = defaultIdFactory,
  logger = createLogger(),
}) {
  const { readRecord, updateRecord, listRecords } = recordRepository;
  const keepaliveLog = logger.child('keepalive');
  const backgroundLog = logger.child('background');
  const resumeLog = logger.child('resume');

  /**
   * In-memory job registry to prevent duplicate pipeline runs while the
   * service worker is alive. Keyed by record key; value is the run promise.
   * @type {Map<string, {promise: Promise<void>, controller: AbortController, pipelineRunId: string}>}
   */
  const jobRegistry = new Map();
  const starting = new Set();

  // Tracks the last `alarms.create` attempt: `create` replaces an existing
  // alarm and restarts its period, so repeated creates would keep pushing the
  // keepalive's fire time out. Deliberately closure state, not a module global:
  // a second supervisor must not inherit another one's throttle.
  let lastKeepAliveCreateAt = 0;

  function scheduleKeepAlive() {
    alarms.get(KEEPALIVE_ALARM, (existing) => {
      // lastError persists for the whole callback, so a successful create below
      // wouldn't clear a get failure; compare by identity against createError.
      const getError = runtime.lastError;
      const getFailed = !!getError;
      if (getFailed) {
        // `existing` can't be trusted after a failed get, but bailing out here
        // would guarantee no alarm exists, so retry `create` below instead.
        // Skip it if already created this period, or the alarm would never fire.
        logger.warn('chrome.alarms.get failed:', getError);
        if (clock() - lastKeepAliveCreateAt < KEEPALIVE_PERIOD_MINUTES * 60_000) return;
      }
      if (getFailed || !existing) {
        // Only a successful create may stamp the throttle — a failed create
        // leaves no alarm to protect, so suppressing the next attempt would
        // strand the keepalive. Stamped optimistically below; released if it rejects.
        try {
          const created = alarms.create(KEEPALIVE_ALARM, {
            periodInMinutes: KEEPALIVE_PERIOD_MINUTES,
          });
          if (created && typeof created.then === 'function') {
            const stampedAt = clock();
            lastKeepAliveCreateAt = stampedAt;
            created.catch((err) => {
              // Clear only our own stamp: a rejection landing after a later
              // create succeeded must not clear that stamp and reopen the loop.
              if (lastKeepAliveCreateAt === stampedAt) lastKeepAliveCreateAt = 0;
              logger.warn('chrome.alarms.create failed:', err);
            });
          } else {
            const createError = runtime.lastError;
            if (createError && createError !== getError) {
              logger.warn('chrome.alarms.create failed:', createError);
            } else if (!getFailed) {
              // Only stamp when the get itself succeeded — after a failed get,
              // this lastError may just be that same stale error.
              lastKeepAliveCreateAt = clock();
            }
          }
        } catch (err) {
          logger.warn('chrome.alarms.create failed:', err);
        }
      }
    });
  }

  function cancelActivePipeline(key, options = {}) {
    const job = jobRegistry.get(key);
    if (!job) return false;
    // A handler that read an earlier snapshot must not abort a job subsequently
    // started by the writer that won ownership of this record. Property presence
    // deliberately distinguishes an unguarded cancel from a legacy record whose
    // expected run id is explicitly `undefined`.
    if (
      Object.hasOwn(options, 'expectedPipelineRunId') &&
      job.pipelineRunId !== options.expectedPipelineRunId
    ) {
      return false;
    }
    job.controller.abort();
    jobRegistry.delete(key);
    // Intentionally do NOT clear the keepalive alarm here: the in-memory registry
    // is not the source of truth for whether work remains. A record can still be
    // in an in-flight status in storage (e.g. an aborted run that left its status
    // untouched). The onAlarm handler is the only place allowed to clear the
    // alarm, and it does so from storage after confirming nothing is in-flight.
    return true;
  }

  /**
   * Starts the pipeline for a key if it is not already running.
   * Resumes orphaned in-flight records (e.g. after a service-worker restart).
   * Registry presence proves this worker still owns the run; storage may remain
   * unchanged for the full duration of a long-running provider request.
   *
   * @param {string} key
   * @returns {Promise<void>}
   */
  async function startPipeline(key) {
    if (starting.has(key)) return;

    starting.add(key);
    try {
      // Arm the recovery alarm before the first storage read, not after it.
      // Callers persist an in-flight status and answer `{ok: true}` before this
      // runs (submit, retry, reprocess, Generate summaries, Retry/Skip), so a
      // failing read here would otherwise leave the record in-flight with no job,
      // no alarm and nothing left to resume it — the UI would wait forever. The
      // onAlarm handler clears the alarm as soon as storage says nothing is
      // in-flight, so arming it for a record that turns out not to need it costs
      // a single alarm tick.
      scheduleKeepAlive();

      const rec = await readRecord(key);
      if (!rec) return;

      if (!isInFlightStatus(rec.status)) return;

      // An entry here is stronger evidence than storage timestamps: provider
      // calls can legitimately produce no writes for many hours. Orphaned jobs
      // are still recovered because the registry is empty after worker restart.
      if (jobRegistry.has(key)) return;

      const pipelineRunId = rec.pipelineRunId;

      const controller = new AbortController();
      const promise = runPipeline(key, {
        pipelineRunId,
        signal: controller.signal,
      })
        .catch((err) => {
          backgroundLog.error('pipeline failed for', key, err);
          // Defensive fallback: the pipeline's own attempt to persist an ERROR
          // status on failure (orchestrator.js) can itself fail to write, in
          // which case the record would keep an in-flight status forever and
          // the keepalive alarm would re-run this failing pipeline every 30s.
          // Best-effort re-attempt here; if this also fails there's nothing
          // further we can safely do without risking a retry loop of writes.
          // `expectedPipelineRunId` mirrors runtime.update (pipelineRuntime.js)
          // so a superseded run's fallback can never clobber a newer run that
          // has since taken ownership of this record — the same run-id guard
          // orchestrator.js relies on for its own AbortError handling.
          return updateRecord(
            key,
            { status: PIPELINE_STATUS.ERROR, error: formatPipelineError(err) },
            { expectedPipelineRunId: pipelineRunId },
          )
            .then((updated) => {
              if (!updated) {
                // Guard rejected the write (record no longer owned by this run,
                // or already gone): someone else owns the record now, so no
                // fallback is needed. Not an error.
                logger.warn('fallback error-status write skipped (record superseded) for', key);
              }
            })
            .catch((fallbackErr) => {
              logger.error('fallback error-status write also failed for', key, fallbackErr);
            });
        })
        .finally(() => {
          const current = jobRegistry.get(key);
          if (current?.promise === promise) {
            jobRegistry.delete(key);
          }
          // Do not clear the keepalive alarm from here. If this run finished by
          // being aborted, the record may still be in an in-flight status in
          // storage; clearing the alarm would orphan it with nothing left to
          // resume it. The onAlarm handler clears the alarm from storage truth.
        });

      jobRegistry.set(key, { promise, controller, pipelineRunId });
      return promise;
    } finally {
      starting.delete(key);
    }
  }

  /**
   * Handles one keepalive tick: resumes in-flight records that lost their SW
   * context, and clears the alarm once storage says nothing is left to do. This
   * is the only place allowed to clear the keepalive.
   *
   * @param {{name: string}} alarm
   */
  function handleKeepAliveAlarm(alarm) {
    if (alarm.name !== KEEPALIVE_ALARM) return;
    // Resume any in-flight records that lost their SW context (e.g. after SW termination).
    listRecords()
      .then((items) => {
        const inFlight = items.filter(isInFlightRecord);
        if (inFlight.length === 0) {
          alarms.clear(KEEPALIVE_ALARM);
          return;
        }
        for (const rec of inFlight) {
          startPipeline(rec.key).catch((err) => {
            keepaliveLog.error('resume failed for', rec.key, err);
          });
        }
      })
      .catch((err) => {
        keepaliveLog.error('listRecords failed:', err);
      });
  }

  /**
   * Reconciles storage against the in-memory job registry: any record still in an
   * in-flight status is (re)started and the keepalive alarm is (re)armed. The
   * job registry does not survive service-worker termination, and the keepalive
   * alarm can be lost across a browser restart or extension update, so this scan
   * is what repairs records that would otherwise be orphaned mid-pipeline (see
   * onStartup/onInstalled in background.js). startPipeline dedupes against the
   * registry, so calling this when jobs are already healthy is a no-op.
   */
  async function resumeInFlightRecords() {
    let items;
    try {
      items = await listRecords();
    } catch (err) {
      resumeLog.warn('scan failed:', err);
      return;
    }
    const inFlight = (Array.isArray(items) ? items : []).filter(isInFlightRecord);
    if (inFlight.length === 0) return;
    scheduleKeepAlive();
    for (const rec of inFlight) {
      startPipeline(rec.key).catch((err) => {
        resumeLog.error('failed for', rec.key, err);
      });
    }
  }

  return {
    startPipeline,
    cancelActivePipeline,
    scheduleKeepAlive,
    handleKeepAliveAlarm,
    resumeInFlightRecords,
    createPipelineRunId: idFactory,

    /**
     * True while a run for this record is registered or being started.
     * @param {string} key Record key.
     */
    isActive: (key) => jobRegistry.has(key) || starting.has(key),
    /** Run promises for every registered job, for callers that must drain them. */
    activeJobPromises: () => Array.from(jobRegistry.values(), (job) => job.promise),
    /** Cancels every registered job. Returns the number of jobs cancelled. */
    cancelAll() {
      let cancelled = 0;
      for (const key of Array.from(jobRegistry.keys())) {
        if (cancelActivePipeline(key)) cancelled += 1;
      }
      return cancelled;
    },
    /** Aborts and drops all state. Test/reset seam. */
    reset() {
      for (const job of jobRegistry.values()) {
        job.controller.abort();
      }
      jobRegistry.clear();
      starting.clear();
    },
  };
}
