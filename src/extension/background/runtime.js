export const RECORD_STORAGE_PREFIX = 'pagetollm:rec:';
export const BOOTSTRAP_WAIT_TIMEOUT_MS = 10_000;

async function waitForBootstrap(bootstrapReady, timeoutMs) {
  let timeoutId;
  try {
    await Promise.race([
      Promise.resolve().then(() => bootstrapReady?.()),
      new Promise((resolve) => {
        timeoutId = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Install worker listeners during initial module evaluation; MV3 can drop
 * cold-start events if registration waits for an async operation.
 *
 * @param {object} deps
 * @param {{onMessage: object, onStartup?: object, onInstalled?: object}} deps.chromeRuntime
 * @param {{onAlarm: object}} deps.chromeAlarms
 * @param {{onChanged: object}} [deps.chromeStorage]
 * @param {function(object, object): Promise<object>} deps.dispatchMessage
 * @param {{handleKeepAliveAlarm: Function, resumeInFlightRecords: Function}} deps.pipelineSupervisor
 * @param {Function} deps.scheduleActionProgressIconRefresh
 * @param {function(): Promise<void>} [deps.bootstrapReady] Resolves once cold-start
 *   storage reconciliation has finished. Read lazily (a thunk, not the promise)
 *   because the entrypoint creates it after this call returns.
 * @param {number} [deps.bootstrapWaitTimeoutMs] Maximum time to preserve bootstrap
 *   ordering before dispatching anyway.
 */
export function installBackgroundRuntime({
  chromeRuntime,
  chromeAlarms,
  chromeStorage,
  dispatchMessage,
  pipelineSupervisor,
  scheduleActionProgressIconRefresh,
  bootstrapReady,
  bootstrapWaitTimeoutMs = BOOTSTRAP_WAIT_TIMEOUT_MS,
}) {
  chromeAlarms.onAlarm.addListener((alarm) => {
    pipelineSupervisor.handleKeepAliveAlarm(alarm);
  });

  try {
    chromeStorage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local') return;
      if (Object.keys(changes).some((key) => key.startsWith(RECORD_STORAGE_PREFIX))) {
        scheduleActionProgressIconRefresh();
      }
    });
  } catch (_) {
    /* noop */
  }

  chromeRuntime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) {
      sendResponse({ ok: false, error: 'no type' });
      return false;
    }

    // The two-arg form prevents a sendResponse error from triggering a second send.
    Promise.resolve()
      .then(() => waitForBootstrap(bootstrapReady, bootstrapWaitTimeoutMs))
      .then(() => dispatchMessage(msg, sender))
      .then(sendResponse, (err) => {
        sendResponse({ ok: false, error: (err && err.message) || String(err) });
      });

    return true;
  });

  // Startup/install events can lose keepalive without reevaluating this module.
  // Wait for storage reconciliation before resuming their in-flight records.
  const resumeAfterBootstrap = async () => {
    try {
      // A bootstrap that fails must not strand in-flight records: the ordering
      // is a preference, resuming at all is the requirement. (`backgroundReady`
      // already swallows its own errors; this covers any other provider.)
      await waitForBootstrap(bootstrapReady, bootstrapWaitTimeoutMs).catch(() => {});
      await pipelineSupervisor.resumeInFlightRecords();
    } catch (_) {
      /* resumeInFlightRecords logs its own failures; nothing to add here. */
    }
  };

  // Guarded because not every runtime (or test harness) exposes these events.
  if (chromeRuntime?.onStartup?.addListener) {
    chromeRuntime.onStartup.addListener(() => {
      void resumeAfterBootstrap();
    });
  }
  if (chromeRuntime?.onInstalled?.addListener) {
    chromeRuntime.onInstalled.addListener(() => {
      void resumeAfterBootstrap();
    });
  }
}
