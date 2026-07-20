import { getStoredVerboseLogs } from '../shared/runtime/verboseLogSettings.js';

/**
 * Creates the console boundary for article-chat diagnostics. Like the
 * pipeline runtime, lifecycle and error stages are always visible while
 * per-request detail is opt-in through the shared verbose-logs setting.
 */
export function createChatLogger() {
  let verboseLogs = false;
  let isReady = false;
  const pendingVerboseEvents = [];

  const write = (stage, details, error) => {
    const method = error ? 'error' : 'info';
    console[method]('PageToLLM Canvas chat:', stage, details);
  };

  // Do not await storage here: the chat loop deliberately starts independent
  // chunks in the same turn. Buffer early detail so the setting still applies
  // even when its storage read completes after the first request starts.
  void getStoredVerboseLogs().then((storedVerboseLogs) => {
    verboseLogs = storedVerboseLogs;
    isReady = true;
    if (verboseLogs) {
      pendingVerboseEvents.forEach(({ stage, details }) => write(stage, details, false));
    }
    pendingVerboseEvents.length = 0;
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
