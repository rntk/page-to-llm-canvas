// Worker-owned builds with durable admission and alarm/checkpoint recovery.

/**
 * @param {object} deps
 * @param {Function} deps.runSummaryTree
 * @param {{error: Function}} deps.logger
 * @param {string} [deps.label] Human-readable tree name for diagnostics.
 * @param {Function} [deps.prepareRun] Persist RUNNING before acknowledging a start.
 * @param {Function} [deps.onFailure] Persist failures that occur before a runner can checkpoint.
 * @param {Function} [deps.listRunningKeys] Read running builds from authoritative storage.
 * @param {Function} [deps.canRecover] Recheck stored eligibility immediately before recovery.
 * @param {Function} [deps.onStop] Persist cancellation even without an in-memory job.
 * @param {object} [deps.alarms] Chrome alarms capability.
 * @param {string} [deps.alarmName] A separate alarm per job registry.
 * @param {{getAll: Function, recordFailure: Function, clear: Function}} [deps.failureBreaker]
 *   The pipeline's session breaker, so automatic recovery cannot rerun forever.
 */
export function createSummaryTreeJobs({
  runSummaryTree,
  logger,
  label = 'summary tree',
  prepareRun = async () => {},
  listRunningKeys = async () => [],
  onFailure = async () => {},
  canRecover = async () => true,
  onStop = async () => false,
  alarms,
  alarmName,
  failureBreaker = null,
}) {
  const jobs = new Map();
  const breaker = failureBreaker || {
    getAll: async () => ({}),
    recordFailure: async () => null,
    clear: async () => {},
  };
  const breakerId = (key) => `${alarmName || 'summary-tree'}:${key}`;

  async function readOpenBreakers() {
    try {
      const entries = (await breaker.getAll()) || {};
      return new Set(Object.keys(entries).filter((id) => entries[id]?.open === true));
    } catch (error) {
      logger.error(`failed to read ${label} breaker:`, error);
      return null;
    }
  }

  async function noteRecoveryFailure(key, error) {
    try {
      await breaker.recordFailure({ key: breakerId(key), pipelineRunId: breakerId(key), error });
    } catch (breakerError) {
      logger.error(`failed to persist ${label} breaker:`, breakerError);
    }
  }

  async function clearRecoveryFailure(key) {
    try {
      await breaker.clear(breakerId(key));
    } catch (error) {
      logger.error(`failed to clear ${label} breaker:`, key, error);
    }
  }

  // A settled run must leave a terminal tree. One still RUNNING (its final
  // write failed) would be rebuilt by every alarm, so count it like the
  // pipeline counts a failed fallback write. Unreadable storage fails closed.
  async function settleRecovery(key) {
    let stillRunning = true;
    try {
      stillRunning = await canRecover(key);
    } catch (_) {
      // Retain the fail-closed verdict.
    }
    if (stillRunning) {
      await noteRecoveryFailure(key, new Error(`${label} run ended without a final status`));
    } else {
      await clearRecoveryFailure(key);
    }
  }
  const admissions = new Map();

  // Serialize only admission and cancellation, never the provider work itself.
  function admit(key, action) {
    const next = (admissions.get(key) || Promise.resolve()).then(action);
    const settled = next.catch(() => {});
    admissions.set(key, settled);
    void settled.then(() => {
      if (admissions.get(key) === settled) admissions.delete(key);
    });
    return next;
  }

  async function armRecovery() {
    if (!alarms) return;
    const existing = await new Promise((resolve) => {
      alarms.get(alarmName, resolve);
    });
    if (!existing) await alarms.create(alarmName, { periodInMinutes: 0.5 });
  }

  const service = {
    /**
     * Persist intent before returning; provider work continues independently.
     * @param {string} key
     * @param {object} [options]
     */
    start(key, { fresh = false, recover = false } = {}) {
      return admit(key, async () => {
        const running = jobs.get(key);
        if (running) {
          // A stopped run keeps its slot until it settles; wait it out so an
          // immediate Resume is not silently dropped.
          if (!running.controller.signal.aborted) return false;
          await running.settled;
          if (jobs.has(key)) return false;
        }
        const controller = new AbortController();
        const job = { controller };
        jobs.set(key, job);
        try {
          await armRecovery();
          if (recover) {
            const open = await readOpenBreakers();
            if (!open || open.has(breakerId(key)) || !(await canRecover(key))) {
              jobs.delete(key);
              return false;
            }
            // Fail closed: prove the checkpoint is still writable before any
            // provider request, as the pipeline's automatic resume does.
            try {
              await prepareRun(key, { fresh: false, recover: true });
            } catch (error) {
              logger.error(`${label} recovery claim failed for`, key, error);
              await noteRecoveryFailure(key, error);
              jobs.delete(key);
              return false;
            }
          } else {
            await clearRecoveryFailure(key);
            await prepareRun(key, { fresh });
          }
          // eslint-disable-next-line require-atomic-updates -- the job is owned by this admission
          job.settled = Promise.resolve()
            .then(() => runSummaryTree(key, { signal: controller.signal, fresh }))
            .catch(async (error) => {
              logger.error(`${label} build failed for`, key, error);
              await onFailure(key, error, { signal: controller.signal });
            })
            .catch((error) => logger.error(`failed to save ${label} failure:`, key, error))
            .then(() => settleRecovery(key))
            .finally(() => {
              if (jobs.get(key) === job) jobs.delete(key);
            })
            .catch(() => {});
          return true;
        } catch (error) {
          if (jobs.get(key) === job) jobs.delete(key);
          throw error;
        }
      });
    },

    /**
     * Only an explicit stop aborts a build; view lifecycles never own it.
     * @param {string} key
     */
    stop(key) {
      return admit(key, async () => {
        const job = jobs.get(key);
        job?.controller.abort();
        const cancelled = await onStop(key);
        return !!job || cancelled;
      });
    },

    isActive(key) {
      return jobs.has(key);
    },

    /** Recover even recent checkpoints: in-memory ownership prevents duplicates. */
    async resumeInFlight() {
      try {
        const keys = await listRunningKeys();
        if (!keys.length && !jobs.size) {
          await alarms?.clear(alarmName);
          return;
        }
        await armRecovery();
        // An unreadable breaker skips this tick only; the alarm stays armed.
        const open = await readOpenBreakers();
        if (!open) return;
        const resumable = keys.filter((key) => !open.has(breakerId(key)));
        if (!resumable.length && !jobs.size) {
          await alarms?.clear(alarmName);
          return;
        }
        for (const key of resumable) await service.start(key, { recover: true });
      } catch (error) {
        logger.error(`${label} recovery failed:`, error);
      }
    },

    handleKeepAliveAlarm(alarm) {
      if (alarm.name === alarmName) void service.resumeInFlight();
    },
  };
  return service;
}
