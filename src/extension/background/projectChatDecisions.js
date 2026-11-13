import { executeDecisionWithRetry } from '../../core/llm/decisionRetry.js';
import { LLM_TASK_TYPES } from '../../shared/runtime/telemetry.js';
import { CHAT_KEEPALIVE_INTERVAL_MS } from './chatCompletionService.js';

const NO_PROVIDER_MESSAGE = 'No decision provider is selected for the project chat page scan.';
const CANCELLED_MESSAGE = 'The page scan was cancelled.';

// Metrics bucket for the scan. A dedicated task type keeps these calls out of
// the topic-splitter statistics wrapDecide would otherwise default to.
const SCAN_TASK_TYPE = LLM_TASK_TYPES.CHAT_PAGE_SCAN;

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Same server identity the pipeline queues by, so one server shares its slots.
 * @param {{url?: string, type?: string}} provider
 * @returns {string}
 */
function providerQueueKey(provider) {
  try {
    return provider?.url
      ? new URL(provider.url).href.replace(/\/+$/, '').replace(/\/v1$/, '')
      : (provider?.type ?? 'decision');
  } catch {
    return provider?.type ?? 'decision';
  }
}

/**
 * Runs the project chat's per-page relevance questions against the selected
 * page-scan decision provider. The API key never leaves this service: callers
 * receive only the answers (or an error string with the key scrubbed).
 *
 * @param {object} deps
 * @param {function(): Promise<object|null>} deps.getPageScanProvider Selected
 *   decision provider (with token) or null for the completion LLM.
 * @param {function(object): {decide: Function}} deps.createDecisionClient
 * @param {function(function(): Promise<*>, AbortSignal=, object=): Promise<*>} deps.limit
 *   Shared provider-scoped limiter; the third argument carries `providerKey`.
 * @param {Function} deps.wrapDecide Telemetry wrapper, `(decide, {provider, model}) => decide`.
 * @param {function(): (boolean|Promise<boolean>)} [deps.getVerboseLogs]
 * @param {function(): AbortController} [deps.abortControllerFactory]
 * @param {function(): *} [deps.keepAlive] Touches an extension API to reset the
 *   MV3 idle timer. Called on an interval while any request is in flight.
 * @param {number} [deps.keepAliveIntervalMs]
 * @param {Function} [deps.setIntervalFn]
 * @param {Function} [deps.clearIntervalFn]
 * @param {Record<string, Function>} [deps.retryOptions] Overrides for
 *   `executeDecisionWithRetry` (sleep, random, maxAttempts), for tests.
 */
export function createProjectChatDecisionService({
  getPageScanProvider,
  createDecisionClient,
  limit = (task) => task(),
  wrapDecide,
  getVerboseLogs = () => false,
  abortControllerFactory = () => new AbortController(),
  keepAlive = () => {},
  keepAliveIntervalMs = CHAT_KEEPALIVE_INTERVAL_MS,
  setIntervalFn = (fn, ms) => setInterval(fn, ms),
  clearIntervalFn = (id) => clearInterval(id),
  retryOptions = {},
}) {
  // Per-turn abort registry; best-effort like the chat completion service (a
  // worker restart drops the fetches along with the controllers).
  const activeRequests = new Map();
  const allControllers = new Set();
  const activeJobs = new Set();
  let inFlight = 0;
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
    if (inFlight > 0 && heartbeat === null) {
      heartbeat = setIntervalFn(beat, keepAliveIntervalMs);
    } else if (inFlight === 0 && heartbeat !== null) {
      clearIntervalFn(heartbeat);
      heartbeat = null;
    }
  }

  function register(turnId, controller) {
    if (!turnId) return;
    const controllers = activeRequests.get(turnId) || new Set();
    controllers.add(controller);
    activeRequests.set(turnId, controllers);
  }

  function unregister(turnId, controller) {
    if (!turnId) return;
    const controllers = activeRequests.get(turnId);
    if (!controllers) return;
    controllers.delete(controller);
    if (controllers.size === 0) activeRequests.delete(turnId);
  }

  function scrub(message, provider) {
    const text = String(message || 'Decision request failed');
    return provider?.token ? text.split(provider.token).join('[redacted]') : text;
  }

  /**
   * Which strategy the project chat's page scan should use.
   * @returns {Promise<{ok: true, mode: 'decision'|'llm', contextWindowTokens?: number}>}
   */
  async function getConfig() {
    const provider = await getPageScanProvider();
    if (!provider) return { ok: true, mode: 'llm' };
    try {
      // A provider the client rejects (e.g. no usable URL) cannot scan.
      createDecisionClient(provider);
    } catch {
      return { ok: true, mode: 'llm' };
    }
    const tokens = provider.contextWindowTokens;
    return {
      ok: true,
      mode: 'decision',
      ...(Number.isFinite(tokens) && tokens > 0 ? { contextWindowTokens: tokens } : {}),
    };
  }

  /**
   * Sends one typed-question request. Never throws and never fabricates answers.
   * @param {{state: *, questions: Record<string, object>, chatTurnId?: string}} request
   * @returns {Promise<{ok: true, answers: object, model?: string}|{ok: false, error: string, cancelled?: boolean}>}
   */
  async function decide({ state, questions, chatTurnId } = {}) {
    if (!isPlainObject(questions) || Object.keys(questions).length === 0) {
      return { ok: false, error: 'questions must be a non-empty object' };
    }
    const controller = abortControllerFactory();
    const signal = controller.signal;
    register(chatTurnId, controller);
    allControllers.add(controller);
    inFlight++;
    syncHeartbeat();
    const job = runDecision();
    activeJobs.add(job);
    try {
      return await job;
    } finally {
      activeJobs.delete(job);
      allControllers.delete(controller);
      unregister(chatTurnId, controller);
      inFlight--;
      syncHeartbeat();
    }

    async function runDecision() {
      let provider;
      try {
        provider = await getPageScanProvider();
        signal.throwIfAborted();
        if (!provider) return { ok: false, error: NO_PROVIDER_MESSAGE };
        const verboseLogs = (await getVerboseLogs()) === true;
        signal.throwIfAborted();
        const client = createDecisionClient(provider);
        const measuredDecide = wrapDecide(
          (requestState, requestQuestions, options) =>
            client.decide(requestState, requestQuestions, { ...options, verboseLogs }),
          { provider: provider.type, model: provider.model },
        );
        // Each transport attempt takes its own limiter slot, so retry backoff
        // never holds one (as in the pipeline's decision binding).
        const response = await executeDecisionWithRetry(
          () =>
            limit(
              () => measuredDecide(state, questions, { signal, taskType: SCAN_TASK_TYPE }),
              signal,
              { providerKey: providerQueueKey(provider) },
            ),
          { signal, ...retryOptions },
        );
        if (!isPlainObject(response?.answers)) {
          return { ok: false, error: 'The decision provider returned no answers.' };
        }
        return {
          ok: true,
          answers: response.answers,
          ...(typeof response.model === 'string' && response.model
            ? { model: response.model }
            : {}),
        };
      } catch (error) {
        if (signal.aborted) return { ok: false, error: CANCELLED_MESSAGE, cancelled: true };
        return { ok: false, error: scrub(error?.message || error, provider) };
      }
    }
  }

  /**
   * Aborts every decision request of one chat turn.
   * @param {string} turnId
   */
  function cancelTurn(turnId) {
    const controllers = activeRequests.get(turnId);
    if (!controllers) return;
    for (const controller of controllers) controller.abort();
    activeRequests.delete(turnId);
  }

  /** Aborts every in-flight decision request across all turns. */
  function cancelAll() {
    for (const controller of allControllers) controller.abort();
    activeRequests.clear();
  }

  return {
    getConfig,
    decide,
    cancelTurn,
    cancelAll,
    activeCompletionJobs: () => Array.from(activeJobs),
  };
}
