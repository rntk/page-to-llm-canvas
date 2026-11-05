// In-memory registry of summary tree builds. A build runs beside a completed
// record, so it is not an in-flight pipeline run: the supervisor never resumes
// it after the worker restarts, and the view offers a resume instead.

/**
 * @param {object} deps
 * @param {function(string, {signal: AbortSignal, fresh: boolean}): Promise<void>} deps.runSummaryTree
 * @param {{error: Function}} deps.logger
 */
export function createSummaryTreeJobs({ runSummaryTree, logger }) {
  const jobs = new Map();

  return {
    /**
     * Start a build unless one is already running for `key`.
     * @param {string} key
     * @param {{fresh?: boolean}} [options]
     * @returns {boolean} Whether a new build started.
     */
    start(key, { fresh = false } = {}) {
      if (jobs.has(key)) return false;
      const controller = new AbortController();
      const promise = Promise.resolve()
        .then(() => runSummaryTree(key, { signal: controller.signal, fresh }))
        .catch((error) => {
          logger.error('summary tree build failed for', key, error);
        })
        .finally(() => {
          if (jobs.get(key)?.promise === promise) jobs.delete(key);
        });
      jobs.set(key, { controller, promise });
      return true;
    },

    /**
     * @param {string} key
     * @returns {boolean} Whether a running build was stopped.
     */
    stop(key) {
      const job = jobs.get(key);
      if (!job) return false;
      job.controller.abort();
      return true;
    },

    /**
     * @param {string} key
     */
    isActive(key) {
      return jobs.has(key);
    },
  };
}
