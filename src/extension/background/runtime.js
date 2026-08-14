export const RECORD_STORAGE_PREFIX = 'pagetollm:rec:';

/**
 * Installs every browser listener the worker owns.
 *
 * MUST be called synchronously from the entrypoint's top-level body. MV3 only
 * routes an event to a cold-started worker when its listener was registered
 * during the initial module evaluation; registering after an `await` silently
 * drops events with nothing failing loudly.
 *
 * @param {object} deps
 * @param {{onMessage: object, onStartup?: object, onInstalled?: object}} deps.chromeRuntime
 * @param {{onAlarm: object}} deps.chromeAlarms
 * @param {{onChanged: object}} [deps.chromeStorage]
 * @param {function(object, object): Promise<object>} deps.dispatchMessage
 * @param {{handleKeepAliveAlarm: Function, resumeInFlightRecords: Function}} deps.pipelineSupervisor
 * @param {Function} deps.scheduleActionProgressIconRefresh
 */
export function installBackgroundRuntime({
  chromeRuntime,
  chromeAlarms,
  chromeStorage,
  dispatchMessage,
  pipelineSupervisor,
  scheduleActionProgressIconRefresh,
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

    // Two-arg form on purpose: a trailing .catch would also catch a throw from
    // sendResponse itself and then call it a second time, so a failed send would
    // rethrow into an unhandled rejection and leave the sender hanging.
    dispatchMessage(msg, sender).then(sendResponse, (err) => {
      sendResponse({ ok: false, error: (err && err.message) || String(err) });
    });

    return true;
  });

  // Resume orphaned in-flight records when the browser starts or the extension is
  // installed/updated — the two events that can drop the keepalive alarm the
  // running-pipeline resume otherwise depends on. Guarded because not every
  // runtime (or test harness) exposes these events.
  if (chromeRuntime?.onStartup?.addListener) {
    chromeRuntime.onStartup.addListener(() => {
      void pipelineSupervisor.resumeInFlightRecords();
    });
  }
  if (chromeRuntime?.onInstalled?.addListener) {
    chromeRuntime.onInstalled.addListener(() => {
      void pipelineSupervisor.resumeInFlightRecords();
    });
  }
}
