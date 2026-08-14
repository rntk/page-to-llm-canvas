/**
 * Owns in-flight article-chat provider requests: the per-turn abort registry,
 * the set of completion jobs a full reset must drain, and the metric write that
 * closes out each call.
 *
 * @param {object} deps
 * @param {Function} deps.callLLMDirect
 * @param {Function} deps.recordLlmMetric
 * @param {function(): number} [deps.clock]
 * @param {function(): AbortController} [deps.abortControllerFactory]
 */
export function createChatCompletionService({
  callLLMDirect,
  recordLlmMetric,
  clock = Date.now,
  abortControllerFactory = () => new AbortController(),
}) {
  /**
   * One turn can fan out into several provider requests. This registry is
   * deliberately best-effort: MV3 worker termination drops both these
   * controllers and the fetches they own, so there is no resumable request state
   * to persist for a later cancel message.
   */
  const activeChatRequests = new Map();
  const activeChatCompletionJobs = new Set();

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
        temperature = 0.8,
        taskType,
        chatTurnId,
      } = msg;
      if (!prompt && (!Array.isArray(messages) || messages.length === 0)) {
        return { ok: false, error: 'missing prompt or messages' };
      }
      // Record duration/token/cache metrics for chat calls. The orchestrator path
      // is wrapped separately (wrapCallLLMWithRetry); callLLMDirect itself stays
      // unmetered so pipeline calls are not double-counted here.
      const startedAt = clock();
      let sample;
      const controller = chatTurnId ? abortControllerFactory() : null;
      registerChatRequest(chatTurnId, controller);
      let result;
      try {
        result = await callLLMDirect({
          prompt,
          messages,
          tools,
          toolChoice,
          parallelToolCalls,
          temperature,
          signal: controller?.signal,
          metricsCollector: (collected) => {
            if (collected && typeof collected === 'object') sample = collected;
          },
        });
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
    try {
      return await completionJob;
    } finally {
      activeChatCompletionJobs.delete(completionJob);
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
