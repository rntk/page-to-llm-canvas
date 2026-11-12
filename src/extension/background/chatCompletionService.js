/** Heartbeat period, safely under Chrome MV3's 30 s service-worker idle timeout. */
export const CHAT_KEEPALIVE_INTERVAL_MS = 20_000;

/**
 * Owns in-flight article-chat provider requests: the per-turn abort registry,
 * the set of completion jobs a full reset must drain, and the metric write that
 * closes out each call.
 *
 * @param {object} deps
 * @param {Function} deps.callLLMDirectWithRetry Returns the direct result shape after retrying transient failures.
 * @param {Function} deps.recordLlmMetric
 * @param {function(Function, AbortSignal=): Promise<*>} [deps.limit]
 *   Shared provider-scoped limiter. Defaults to direct execution for isolated
 *   consumers and tests.
 * @param {function(): number} [deps.clock]
 * @param {function(): AbortController} [deps.abortControllerFactory]
 * @param {function(): *} [deps.keepAlive] Touches an extension API to reset
 *   the MV3 idle timer. Called on an interval while any completion is in flight.
 * @param {number} [deps.keepAliveIntervalMs]
 * @param {Function} [deps.setIntervalFn]
 * @param {Function} [deps.clearIntervalFn]
 */
export function createChatCompletionService({
  callLLMDirectWithRetry,
  recordLlmMetric,
  limit = (task) => task(),
  clock = Date.now,
  abortControllerFactory = () => new AbortController(),
  keepAlive = () => {},
  keepAliveIntervalMs = CHAT_KEEPALIVE_INTERVAL_MS,
  setIntervalFn = (fn, ms) => setInterval(fn, ms),
  clearIntervalFn = (id) => clearInterval(id),
}) {
  /**
   * One turn can fan out into several provider requests. This registry is
   * deliberately best-effort: MV3 worker termination drops both these
   * controllers and the fetches they own, so there is no resumable request state
   * to persist for a later cancel message.
   */
  const activeChatRequests = new Map();
  const activeChatCompletionJobs = new Set();

  // The worker idles out after 30 s without extension events or API calls, and
  // a slow provider response does not count. A heartbeat under that window keeps
  // the response and the cancel registry alive. Chrome's alarm minimum is 30 s,
  // too coarse for this, so the timer runs in-process.
  let heartbeat = null;

  function beat() {
    try {
      const pending = keepAlive();
      if (pending && typeof pending.catch === 'function') pending.catch(() => {});
    } catch {
      // A failed touch only costs this beat; the next one retries.
    }
  }

  function syncHeartbeat() {
    if (activeChatCompletionJobs.size > 0 && heartbeat === null) {
      heartbeat = setIntervalFn(beat, keepAliveIntervalMs);
    } else if (activeChatCompletionJobs.size === 0 && heartbeat !== null) {
      clearIntervalFn(heartbeat);
      heartbeat = null;
    }
  }

  function registerChatRequest(turnId, controller) {
    if (!turnId) return;
    const controllers = activeChatRequests.get(turnId) || new Set();
    controllers.add(controller);
    activeChatRequests.set(turnId, controllers);
  }

  function unregisterChatRequest(turnId, controller) {
    if (!turnId) return;
    const controllers = activeChatRequests.get(turnId);
    if (!controllers) return;
    controllers.delete(controller);
    if (controllers.size === 0) activeChatRequests.delete(turnId);
  }

  /**
   * Runs one chat completion, tracked so a reset can await its terminal writes.
   * @param {object} msg
   * @returns {Promise<object>}
   */
  async function complete(msg) {
    const completionJob = (async () => {
      const {
        prompt = '',
        messages,
        tools,
        toolChoice,
        parallelToolCalls,
        taskType,
        chatTurnId,
      } = msg;
      if (!prompt && (!Array.isArray(messages) || messages.length === 0)) {
        return { ok: false, error: 'missing prompt or messages' };
      }
      // Record duration/token/cache metrics for chat calls. The orchestrator path
      // is wrapped separately (wrapCallLLMWithRetry); the llm.js calls themselves
      // stay unmetered so pipeline calls are not double-counted here.
      const startedAt = clock();
      let sample;
      const controller = chatTurnId ? abortControllerFactory() : null;
      registerChatRequest(chatTurnId, controller);
      let result;
      try {
        // Retries share the pipeline's policy (429/5xx/network, jittered backoff,
        // Retry-After) and hold the limiter slot through backoff, as the
        // orchestrator does. The turn's signal cancels both waits and requests.
        result = await limit(
          () =>
            callLLMDirectWithRetry({
              prompt,
              messages,
              tools,
              toolChoice,
              parallelToolCalls,
              taskType,
              signal: controller?.signal,
              metricsCollector: (collected) => {
                if (collected && typeof collected === 'object') sample = collected;
              },
            }),
          controller?.signal,
        );
      } finally {
        unregisterChatRequest(chatTurnId, controller);
      }
      // Await (unlike the orchestrator's fire-and-forget): this handler is
      // terminal, so a void'd write could be dropped when the service worker
      // suspends right after the response is sent. recordLlmMetric swallows its
      // own errors and returns void, so awaiting can't fail the response.
      await recordLlmMetric({
        durationMs: clock() - startedAt,
        ok: result.ok,
        taskType,
        error: result.ok ? undefined : result.error,
        ...sample,
      });
      return result;
    })();
    activeChatCompletionJobs.add(completionJob);
    syncHeartbeat();
    try {
      return await completionJob;
    } finally {
      activeChatCompletionJobs.delete(completionJob);
      syncHeartbeat();
    }
  }

  /**
   * Aborts every provider request fanned out from one chat turn.
   * @param {string} turnId
   */
  function cancelTurn(turnId) {
    const controllers = activeChatRequests.get(turnId);
    if (!controllers) return;
    for (const controller of controllers) controller.abort();
    activeChatRequests.delete(turnId);
  }

  /** Aborts every in-flight request across all turns. */
  function cancelAll() {
    for (const controllers of activeChatRequests.values()) {
      for (const controller of controllers) controller.abort();
    }
    activeChatRequests.clear();
  }

  return {
    complete,
    cancelTurn,
    cancelAll,
    /** Completion jobs a reset must let reach their terminal metric writes. */
    activeCompletionJobs: () => Array.from(activeChatCompletionJobs),
  };
}
