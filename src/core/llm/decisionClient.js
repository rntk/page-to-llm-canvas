// Browser counterpart of clef/llama_decisions.py. Responses retain all server fields.
import { createLogger } from '../../shared/runtime/log.js';
import { createRequestTimeoutSignal, mergeAbortSignals } from './abortSignals.js';
import { ProviderType, validateDecisionUrl } from './providers.js';
import { parseRetryAfterMs } from './clients.js';

const log = createLogger('Decision client');

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function tokenCount(value) {
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Maps OpenAI-style `usage` from the decision server onto the metrics usage shape.
 * @param {unknown} usage Server `usage` object.
 */
function decisionUsage(usage) {
  if (!isRecord(usage)) return undefined;
  const mapped = Object.fromEntries(
    [
      // OpenAI-style names from llama.cpp; the TypeSafe API uses input/output_tokens.
      ['inputTokens', tokenCount(usage.prompt_tokens ?? usage.input_tokens)],
      ['outputTokens', tokenCount(usage.completion_tokens ?? usage.output_tokens)],
      ['totalTokens', tokenCount(usage.total_tokens)],
      ['cacheReadTokens', tokenCount(usage.prompt_tokens_details?.cached_tokens)],
    ].filter(([, value]) => value !== undefined),
  );
  return Object.keys(mapped).length ? mapped : undefined;
}

/**
 * Builds a choice question from named option descriptions.
 * @param {*} instructions Text, JSON, or message instructions.
 * @param {Record<string, string|object|Array|null>} criteria Choice options. A structured
 *   description (e.g. `what`, `not_for`, `examples`) separates easily confused options.
 */
export function choice(instructions, criteria) {
  if (
    !isRecord(criteria) ||
    !Object.keys(criteria).length ||
    Object.entries(criteria).some(
      ([name, value]) =>
        !name || (value !== null && typeof value !== 'string' && typeof value !== 'object'),
    )
  ) {
    throw new Error('Choice requires nonempty names with text, JSON, or null descriptions');
  }
  return { type: 'choice', instructions, criteria: { ...criteria } };
}

/** Reusable, non-streaming decision client. Each request has a timeout and no retries. */
export class DecisionClient {
  /**
   * @param {object} [options] Client configuration.
   * @param {string} [options.baseUrl] Server root or URL ending in /v1.
   * @param {string} [options.model] Optional default model.
   * @param {string} [options.apiKey] Optional bearer token.
   * @param {number} [options.timeout] Timeout in seconds.
   * @param {Function} [options.transport] Injectable fetch implementation.
   * @param {{info: Function}} [options.logger] Logger for verbose raw request/response output.
   */
  constructor({
    baseUrl = 'http://localhost:8080',
    model,
    apiKey,
    timeout = 60,
    transport = (...args) => globalThis.fetch(...args),
    logger = log,
  } = {}) {
    validateDecisionUrl(baseUrl, !!apiKey);
    if (!Number.isFinite(timeout) || timeout <= 0)
      throw new Error('Timeout must be a finite positive number of seconds');
    if (typeof transport !== 'function') throw new Error('Decision transport is required');
    const root = baseUrl.trim().replace(/\/+$/, '');
    this.baseUrl = root.endsWith('/v1') ? root : `${root}/v1`;
    this.model = model;
    this.apiKey = apiKey;
    this.timeout = timeout;
    this.transport = transport;
    this.logger = logger;
  }

  /**
   * Answers named questions while preserving probabilities, model, and usage.
   * @param {*} state Text, JSON, or chat-message state.
   * @param {Record<string, object>} questions Nonempty mapping of question ids.
   * @param {object} [options] Per-request overrides.
   * @param {string} [options.model] Model override.
   * @param {AbortSignal} [options.signal] Caller cancellation signal.
   * @param {boolean} [options.verboseLogs] Logs the raw request and response bodies.
   * @param {function(Record<string, unknown>): void} [options.metricsCollector] Receives
   *   provider, model, request/response sizes, and token usage after a successful request.
   */
  async decide(
    state,
    questions,
    { model = this.model, signal, metricsCollector, verboseLogs = false } = {},
  ) {
    if (
      !isRecord(questions) ||
      !Object.keys(questions).length ||
      Object.entries(questions).some(([name, question]) => !name || !isRecord(question))
    ) {
      throw new Error('Questions must be a nonempty mapping of named question objects');
    }
    const payload = { state, questions };
    if (model != null && model !== '') payload.model = model;
    let sizes;
    const response = await this.request(
      'systemone',
      payload,
      signal,
      (value) => {
        sizes = value;
      },
      verboseLogs,
    );
    if (!isRecord(response.answers)) throw new Error("Server response has no 'answers' object");
    metricsCollector?.({
      provider: ProviderType.LLAMA_DECISION,
      model: typeof response.model === 'string' && response.model ? response.model : model,
      ...sizes,
      usage: decisionUsage(response.usage),
    });
    return response;
  }

  /**
   * Sends one JSON POST request, preserving HTTP error status and raw body.
   * @param {string} endpoint Relative API endpoint.
   * @param {object} payload Request body.
   * @param {AbortSignal} [signal] Caller cancellation signal.
   * @param {function({requestChars: number, responseChars: number}): void} [onSizes]
   *   Receives request and response sizes of a successful request.
   * @param {boolean} [verboseLogs] Logs the raw request, response, and HTTP error body.
   *   The Authorization header is never logged.
   */
  async request(endpoint, payload, signal, onSizes, verboseLogs = false) {
    const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    const timeoutSignal = createRequestTimeoutSignal(this.timeout * 1000);
    const merged = mergeAbortSignals(signal, timeoutSignal.signal);
    const requestBody = JSON.stringify(payload);
    const url = `${this.baseUrl}/${endpoint}`;
    try {
      merged.signal.throwIfAborted();
      if (verboseLogs)
        this.logger.info('request:', { endpoint: url, method: 'POST', body: payload });
      const response = await this.transport(url, {
        method: 'POST',
        headers,
        body: requestBody,
        signal: merged.signal,
      });
      if (!response.ok) {
        const body = await response.text();
        if (verboseLogs) {
          this.logger.info('raw error response:', { endpoint: url, status: response.status, body });
        }
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch (_) {
          parsed = null;
        }
        throw Object.assign(new Error(`llama.cpp returned HTTP ${response.status}: ${body}`), {
          status: response.status,
          retryAfterMs: parseRetryAfterMs(response.headers?.get?.('Retry-After')),
          body,
          response: parsed,
        });
      }
      let result;
      try {
        result = await response.json();
      } catch (error) {
        if (merged.signal.aborted) throw error;
        throw new Error('Server returned invalid JSON');
      }
      if (verboseLogs) this.logger.info('raw response data:', result);
      if (!isRecord(result)) throw new Error('Server response must be a JSON object');
      // Re-serialized size; whitespace may differ from the wire body.
      onSizes?.({
        requestChars: requestBody.length,
        responseChars: JSON.stringify(result).length,
      });
      return result;
    } finally {
      timeoutSignal.dispose();
      merged.dispose();
    }
  }
}
