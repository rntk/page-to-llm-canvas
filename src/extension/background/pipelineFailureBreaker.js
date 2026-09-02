export const PIPELINE_FAILURE_BREAKER_KEY = 'pagetollm:pipeline-failure-breakers';
export const STORAGE_UNAVAILABLE_MESSAGE =
  'Processing was paused because extension storage is unavailable. Free storage or restart the browser, then retry.';

const DEFAULT_THRESHOLD = 3;
const MAX_ENTRIES = 100;

function asError(operation, runtime) {
  return new Error(runtime?.lastError?.message || `${operation} failed`);
}

function getAreaItems(area, runtime, key) {
  return new Promise((resolve, reject) => {
    area.get(key, (items) => {
      if (runtime?.lastError) return reject(asError('storage.session.get', runtime));
      resolve(items || {});
    });
  });
}

function setAreaItems(area, runtime, items) {
  return new Promise((resolve, reject) => {
    area.set(items, () => {
      if (runtime?.lastError) return reject(asError('storage.session.set', runtime));
      resolve();
    });
  });
}

/**
 * A small circuit breaker backed by chrome.storage.session. Session storage is
 * owned by the browser process, so it survives MV3 service-worker recycling
 * without pretending to be durable across a full browser restart.
 */
export function createPipelineFailureBreaker({
  getStorageArea,
  runtime,
  threshold = DEFAULT_THRESHOLD,
  clock = Date.now,
}) {
  // Test/old-browser fallback only. Supported Chrome builds use storage.session.
  const fallback = {};
  let queue = Promise.resolve();

  const withQueue = (task) => {
    const next = queue.then(task, task);
    queue = next.catch(() => {});
    return next;
  };

  async function readAll() {
    const area = getStorageArea?.();
    if (!area) return { ...fallback };
    const items = await getAreaItems(area, runtime, PIPELINE_FAILURE_BREAKER_KEY);
    const value = items[PIPELINE_FAILURE_BREAKER_KEY];
    return value && typeof value === 'object' ? value : {};
  }

  async function writeAll(entries) {
    const area = getStorageArea?.();
    if (!area) {
      for (const key of Object.keys(fallback)) delete fallback[key];
      Object.assign(fallback, entries);
      return;
    }
    await setAreaItems(area, runtime, { [PIPELINE_FAILURE_BREAKER_KEY]: entries });
  }

  return {
    get(pipelineRunId) {
      if (!pipelineRunId) return Promise.resolve(null);
      // Reads join the write queue so callers never observe the snapshot from
      // the middle of a recordFailure read-modify-write.
      return withQueue(async () => (await readAll())[pipelineRunId] || null);
    },

    getAll() {
      return withQueue(readAll);
    },

    recordFailure({ key, pipelineRunId, error }) {
      if (!pipelineRunId) return Promise.resolve(null);
      return withQueue(async () => {
        const entries = await readAll();
        const previous = entries[pipelineRunId];
        const failures = (Number(previous?.failures) || 0) + 1;
        entries[pipelineRunId] = {
          key,
          pipelineRunId,
          failures,
          open: failures >= threshold,
          message: STORAGE_UNAVAILABLE_MESSAGE,
          detail: (error && error.message) || String(error || 'storage write failed'),
          updatedAt: clock(),
        };
        const ordered = Object.values(entries).sort((a, b) => b.updatedAt - a.updatedAt);
        // Open entries are safety decisions, not cache entries. Never evict
        // them merely because newer failures arrived; only closed/low-count
        // entries are subject to the soft cap.
        const openEntries = ordered.filter((entry) => entry.open === true);
        const closedEntries = ordered
          .filter((entry) => entry.open !== true)
          .slice(0, Math.max(0, MAX_ENTRIES - openEntries.length));
        const retained = [...openEntries, ...closedEntries];
        const trimmed = Object.fromEntries(retained.map((entry) => [entry.pipelineRunId, entry]));
        await writeAll(trimmed);
        return trimmed[pipelineRunId];
      });
    },

    clear(pipelineRunId) {
      if (!pipelineRunId) return Promise.resolve();
      return withQueue(async () => {
        const entries = await readAll();
        if (!entries[pipelineRunId]) return;
        delete entries[pipelineRunId];
        await writeAll(entries);
      });
    },

    clearForKey(key, exceptPipelineRunId) {
      return withQueue(async () => {
        const entries = await readAll();
        if (!key) {
          if (Object.keys(entries).length > 0) await writeAll({});
          return;
        }
        let changed = false;
        for (const [runId, entry] of Object.entries(entries)) {
          if (entry?.key !== key || runId === exceptPipelineRunId) continue;
          delete entries[runId];
          changed = true;
        }
        if (changed) await writeAll(entries);
      });
    },
  };
}
