import { getStoredVerboseLogs } from '../shared/runtime/verboseLogSettings.js';
import { createLogger } from '../shared/runtime/log.js';

const log = createLogger('chat:');

/**
 * Console boundary for article-chat diagnostics. Lifecycle and error stages
 * always log; per-request detail needs the verbose-logs setting.
 */
export function createChatLogger() {
  let verboseLogs = false;
  let isReady = false;
  const pendingVerboseEvents = [];

  const write = (stage, details, error) => {
    log.event(stage, details, { error });
  };

  // Not awaited: chunks start immediately, so buffer early verbose events until the setting loads.
  void getStoredVerboseLogs()
    .then((storedVerboseLogs) => {
      verboseLogs = storedVerboseLogs;
      isReady = true;
      if (verboseLogs) {
        pendingVerboseEvents.forEach(({ stage, details }) => write(stage, details, false));
      }
      pendingVerboseEvents.length = 0;
    })
    .catch((err) => {
      // Setting unreadable: stay non-verbose and stop buffering.
      isReady = true;
      pendingVerboseEvents.length = 0;
      log.warn('verbose log setting load failed:', err);
    });

  return (stage, details = {}, { verbose = false, error = false } = {}) => {
    if (verbose) {
      if (!isReady) {
        pendingVerboseEvents.push({ stage, details });
        return;
      }
      if (!verboseLogs) return;
    }
    write(stage, details, error);
  };
}
