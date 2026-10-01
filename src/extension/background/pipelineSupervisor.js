import { formatPipelineError } from './pipeline/pipelineRuntime.js';
import { isInFlightPipelineStatus, isInFlightRecord } from '../../shared/runtime/contracts.js';
import { errorTransition } from '../../shared/runtime/recordTransitions.js';
import { createLogger } from '../../shared/runtime/log.js';
import { STORAGE_UNAVAILABLE_MESSAGE } from './pipelineFailureBreaker.js';

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
 * Own running jobs, the keepalive alarm, and recovery from stored records.
 * Browser APIs arrive through injected accessors resolved at call time.
 *
 * @param {object} deps
 * @param {{readRecord: Function, updateRecord: Function, listRecords: Function}} deps.recordRepository
 * @param {Function} deps.runPipeline
 * @param {{get: Function, create: Function, clear: Function, onAlarm?: object}} deps.alarms
 * @param {{lastError: *}} deps.runtime Carries `lastError`; read per access.
 * @param {{getAll: Function, recordFailure: Function, clear: Function, clearForKey: Function}} [deps.failureBreaker]
 * @param {function(): number} [deps.clock]
 * @param {function(): string} [deps.idFactory]
 * @param {object} [deps.logger] Base logger; scoped children are derived here.
 */
export function createPipelineSupervisor({
  recordRepository,
  runPipeline,
  alarms,
  runtime,
  failureBreaker = null,
  clock = Date.now,
  idFactory = defaultIdFactory,
  logger = createLogger(),
}) {
  const { readRecord, updateRecord, listRecords } = recordRepository;
  const keepaliveLog = logger.child('keepalive');
  const backgroundLog = logger.child('background');
  const resumeLog = logger.child('resume');

  /**
   * Active jobs keyed by record key; prevents duplicate runs in this worker.
   * @type {Map<string, {promise: Promise<void>, controller: AbortController, pipelineRunId: string}>}
   */
  const jobRegistry = new Map();
  const starting = new Set();

  const breaker = failureBreaker || {
    getAll: async () => ({}),
    recordFailure: async () => null,
    clear: async () => {},
    clearForKey: async () => {},
  };

  async function readBreakerSnapshot() {
    try {
      return { ok: true, entries: await breaker.getAll() };
    } catch (error) {
      logger.error('failed to read pipeline storage breaker:', error);
      return { ok: false, entries: {}, error };
    }
  }

  function openStateFromSnapshot(record, snapshot) {
    if (!snapshot.ok || !record?.pipelineRunId) return null;
    const state = snapshot.entries[record.pipelineRunId];
    return state?.open === true ? state : null;
  }

  async function noteStorageFailure(key, pipelineRunId, error) {
    try {
      return await breaker.recordFailure({ key, pipelineRunId, error });
    } catch (breakerError) {
      logger.error('failed to persist pipeline storage breaker:', breakerError);
      return null;
    }
  }

  async function clearStorageFailure(key, pipelineRunId) {
    try {
      await breaker.clear(pipelineRunId);
    } catch (error) {
      logger.warn('failed to clear pipeline storage breaker for', key, error);
    }
  }

  async function clearObsoleteStorageFailures(key, pipelineRunId) {
    try {
      await breaker.clearForKey(key, pipelineRunId);
    } catch (error) {
      logger.warn('failed to clear obsolete pipeline storage breakers for', key, error);
    }
  }

  // Repeated creates reset the alarm period; throttle per supervisor so it fires.
  let lastKeepAliveCreateAt = 0;

  function scheduleKeepAlive() {
    alarms.get(KEEPALIVE_ALARM, (existing) => {
      // lastError persists throughout the callback; compare create errors by identity.
      const getError = runtime.lastError;
      const getFailed = !!getError;
      if (getFailed) {
        // A failed get cannot prove an alarm exists. Retry create after one period.
        logger.warn('chrome.alarms.get failed:', getError);
        if (clock() - lastKeepAliveCreateAt < KEEPALIVE_PERIOD_MINUTES * 60_000) return;
      }
      if (getFailed || !existing) {
        // Release an optimistic throttle stamp if create rejects.
        try {
          const created = alarms.create(KEEPALIVE_ALARM, {
            periodInMinutes: KEEPALIVE_PERIOD_MINUTES,
          });
          if (created && typeof created.then === 'function') {
            const stampedAt = clock();
            lastKeepAliveCreateAt = stampedAt;
            created.catch((err) => {
              // A late rejection must not clear a newer create's stamp.
              if (lastKeepAliveCreateAt === stampedAt) lastKeepAliveCreateAt = 0;
              logger.warn('chrome.alarms.create failed:', err);
            });
          } else {
            const createError = runtime.lastError;
            if (createError && createError !== getError) {
              logger.warn('chrome.alarms.create failed:', createError);
            } else if (!getFailed) {
              // After a failed get, lastError may still be that get error.
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
    // Guard against aborting a newer run; property presence distinguishes an
    // unguarded cancel from an expected id of undefined.
    if (
      Object.hasOwn(options, 'expectedPipelineRunId') &&
      job.pipelineRunId !== options.expectedPipelineRunId
    ) {
      return false;
    }
    job.controller.abort();
    jobRegistry.delete(key);
    // Only onAlarm clears keepalive, after storage confirms no work remains.
    return true;
  }

  /**
   * Start or resume an in-flight record unless this worker already owns its job.
   * Long provider requests may leave storage unchanged for hours.
   *
   * @param {string} key
   * @param {{automatic?: boolean, breakerSnapshot?: object}} [options]
   * @returns {Promise<void>}
   */
  async function startPipeline(key, options = {}) {
    if (starting.has(key)) return;

    starting.add(key);
    try {
      // Arm recovery before reading storage: callers have already persisted an
      // in-flight status, and a failed read must not orphan it.
      scheduleKeepAlive();

      const rec = await readRecord(key);
      if (!rec) return;

      if (!isInFlightPipelineStatus(rec.status)) return;

      // Registry ownership is reliable even when provider work makes no writes.
      if (jobRegistry.has(key)) return;

      const pipelineRunId = rec.pipelineRunId;

      if (options.automatic) {
        const snapshot = options.breakerSnapshot || (await readBreakerSnapshot());
        // A confirmed open breaker deliberately stops this run. An unknown
        // breaker state skips only this attempt; the keepalive remains armed
        // so a transient session-storage read failure can self-heal.
        if (!snapshot.ok || openStateFromSnapshot(rec, snapshot)) return;
        // Automatic recovery is fail-closed: prove that this run can still
        // persist its ownership before allowing it to approach provider work.
        // The guarded no-op patch is also safe if the record was superseded
        // after the read above.
        try {
          const claimed = await updateRecord(key, {}, { expectedPipelineRunId: pipelineRunId });
          if (!claimed || !isInFlightPipelineStatus(claimed.status)) return;
        } catch (claimError) {
          await noteStorageFailure(key, pipelineRunId, claimError);
          backgroundLog.error('automatic resume storage claim failed for', key, claimError);
          return;
        }
      } else {
        // User-initiated retries mint a new run id. Remove breaker entries for
        // older runs of this record so they cannot consume session quota.
        await clearObsoleteStorageFailures(key, pipelineRunId);
      }

      const controller = new AbortController();
      let failed = false;
      const promise = runPipeline(key, {
        pipelineRunId,
        signal: controller.signal,
      })
        .catch(async (err) => {
          failed = true;
          backgroundLog.error('pipeline failed for', key, err);
          // Defensive fallback: the pipeline's own attempt to persist an ERROR
          // status on failure (orchestrator.js) can itself fail to write, in
          // which case the record would keep an in-flight status forever and
          // the keepalive alarm would re-run this failing pipeline every 30s.
          // Best-effort re-attempt here. Repeated failure opens a browser-session
          // circuit breaker so alarms cannot retry this run forever.
          // `expectedPipelineRunId` mirrors runtime.update (pipelineRuntime.js)
          // so a superseded run's fallback can never clobber a newer run that
          // has since taken ownership of this record — the same run-id guard
          // orchestrator.js relies on for its own AbortError handling.
          try {
            const updated = await updateRecord(key, errorTransition(formatPipelineError(err)), {
              expectedPipelineRunId: pipelineRunId,
            });
            if (!updated) {
              logger.warn('fallback error-status write skipped (record superseded) for', key);
            }
            await clearStorageFailure(key, pipelineRunId);
          } catch (fallbackErr) {
            logger.error('fallback error-status write also failed for', key, fallbackErr);
            // If the authoritative read works and is already terminal, there is
            // no runaway record to break. A failed read is treated fail-closed.
            let stillOwnedAndInFlight = true;
            try {
              const latest = await readRecord(key);
              stillOwnedAndInFlight =
                latest?.pipelineRunId === pipelineRunId && isInFlightPipelineStatus(latest?.status);
            } catch (_) {
              // Storage is unavailable; retain the fail-closed verdict.
            }
            if (stillOwnedAndInFlight) {
              await noteStorageFailure(key, pipelineRunId, fallbackErr);
            } else {
              await clearStorageFailure(key, pipelineRunId);
            }
          }
        })
        .finally(() => {
          if (!failed) {
            void clearStorageFailure(key, pipelineRunId);
          }
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
      .then(async (items) => {
        const inFlight = items.filter(isInFlightRecord);
        if (inFlight.length === 0) {
          if (jobRegistry.size > 0 || starting.size > 0) return;
          alarms.clear(KEEPALIVE_ALARM);
          return;
        }
        const snapshot = await readBreakerSnapshot();
        if (!snapshot.ok) return;
        const resumable = [];
        for (const rec of inFlight) {
          if (!openStateFromSnapshot(rec, snapshot)) resumable.push(rec);
        }
        if (resumable.length === 0) {
          if (jobRegistry.size > 0 || starting.size > 0) return;
          alarms.clear(KEEPALIVE_ALARM);
          return;
        }
        for (const rec of resumable) {
          startPipeline(rec.key, { automatic: true, breakerSnapshot: snapshot }).catch((err) => {
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
   * is what repairs records that would otherwise be orphaned mid-pipeline. It
   * runs on every cold start plus onStartup/onInstalled (see background.js).
   * startPipeline dedupes against the registry, so calling this when jobs are
   * already healthy is a no-op.
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
    if (inFlight.length === 0) {
      if (jobRegistry.size > 0 || starting.size > 0) return;
      alarms.clear(KEEPALIVE_ALARM);
      return;
    }
    // Startup/install recovery must recreate the alarm before consulting the
    // session breaker: its read can fail transiently, and the prior alarm may
    // have been lost across the lifecycle event that invoked this scan.
    scheduleKeepAlive();
    const snapshot = await readBreakerSnapshot();
    if (!snapshot.ok) return;
    const resumable = [];
    for (const rec of inFlight) {
      if (!openStateFromSnapshot(rec, snapshot)) resumable.push(rec);
    }
    if (resumable.length === 0) {
      if (jobRegistry.size > 0 || starting.size > 0) return;
      alarms.clear(KEEPALIVE_ALARM);
      return;
    }
    for (const rec of resumable) {
      startPipeline(rec.key, { automatic: true, breakerSnapshot: snapshot }).catch((err) => {
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
     * Returns transient runtime failures separately from persisted records.
     * One breaker snapshot classifies the entire response consistently.
     * @param {object[]} records Persisted record projections.
     * @returns {Promise<{failures: Record<string, object>, unavailable: boolean}>}
     */
    async getPipelineFailures(records) {
      const snapshot = await readBreakerSnapshot();
      if (!snapshot.ok) return { failures: {}, unavailable: true };
      const failures = {};
      for (const record of Array.isArray(records) ? records : []) {
        if (!isInFlightRecord(record)) continue;
        const state = openStateFromSnapshot(record, snapshot);
        if (!state) continue;
        failures[record.key] = {
          kind: 'storage_unavailable',
          message: state.message || STORAGE_UNAVAILABLE_MESSAGE,
          retryable: true,
          pipelineRunId: record.pipelineRunId,
        };
      }
      return { failures, unavailable: false };
    },

    async clearPipelineFailuresForKey(key) {
      await clearObsoleteStorageFailures(key);
    },

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
