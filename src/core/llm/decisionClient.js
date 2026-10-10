// Browser counterpart of clef/llama_decisions.py. Responses retain all server fields.
import { createRequestTimeoutSignal, mergeAbortSignals } from './abortSignals.js';

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
      ['inputTokens', tokenCount(usage.prompt_tokens)],
      ['outputTokens', tokenCount(usage.completion_tokens)],
      ['totalTokens', tokenCount(usage.total_tokens)],
      ['cacheReadTokens', tokenCount(usage.prompt_tokens_details?.cached_tokens)],
    ].filter(([, value]) => value !== undefined),
  );
  return Object.keys(mapped).length ? mapped : undefined;
}

/**
 * Builds a choice question from named descriptions or an array of option names.
 * @param {*} instructions Text, JSON, or message instructions.
 * @param {Record<string, string|null>|string[]} criteria Choice options.
 */
export function choice(instructions, criteria) {
  if (Array.isArray(criteria) && new Set(criteria).size !== criteria.length) {
    throw new Error('Choice option names must be unique');
  }
  const options = Array.isArray(criteria)
    ? Object.fromEntries(criteria.map((name) => [name, null]))
    : criteria;
  if (
    !isRecord(options) ||
    !Object.keys(options).length ||
    (Array.isArray(criteria) && criteria.some((name) => typeof name !== 'string' || !name)) ||
    Object.entries(options).some(
      ([name, value]) => !name || (value !== null && typeof value !== 'string'),
    )
  ) {
    throw new Error('Choice requires nonempty string names with string or null descriptions');
  }
  return { type: 'choice', instructions, criteria: { ...options } };
}

/**
 * Builds a score question; levels are ordered lowest first.
 * @param {*} instructions Question instructions.
 * @param {string[]} criteria Two to ten level descriptions.
 */
export function score(instructions, criteria) {
  if (
    !Array.isArray(criteria) ||
    criteria.length < 2 ||
    criteria.length > 10 ||
    criteria.some((value) => typeof value !== 'string')
  ) {
    throw new Error('Score requires 2–10 string level descriptions');
  }
  return { type: 'score', instructions, criteria: [...criteria] };
}

/**
 * Builds a yes/no question whose answer's noul field is P(true).
 * @param {*} instructions Question instructions.
 * @param {object} [options] Optional answer descriptions.
 * @param {string|null} [options.trueDescription] Description of true.
 * @param {string|null} [options.falseDescription] Description of false.
 */
export function noul(instructions, { trueDescription = null, falseDescription = null } = {}) {
  if (
    [trueDescription, falseDescription].some((value) => value !== null && typeof value !== 'string')
  ) {
    throw new Error('Noul descriptions must be strings or null');
  }
  return {
    type: 'noul',
    instructions,
    ...(trueDescription !== null || falseDescription !== null
      ? { criteria: { true: trueDescription, false: falseDescription } }
      : {}),
  };
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
   */
  constructor({
    baseUrl = 'http://localhost:8080',
    model,
    apiKey,
    timeout = 60,
    transport = (...args) => globalThis.fetch(...args),
  } = {}) {
    const parsed = new URL(baseUrl);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.search || parsed.hash) {
      throw new Error('Base URL must be an HTTP(S) server URL without query or fragment');
    }
    if (!Number.isFinite(timeout) || timeout <= 0)
      throw new Error('Timeout must be a finite positive number of seconds');
    if (typeof transport !== 'function') throw new Error('Decision transport is required');
    if (
      apiKey &&
      parsed.protocol !== 'https:' &&
      !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
    ) {
      throw new Error('Refusing to send an API token to a non-HTTPS provider URL');
    }
    const root = baseUrl.trim().replace(/\/+$/, '');
    this.baseUrl = root.endsWith('/v1') ? root : `${root}/v1`;
    this.model = model;
    this.apiKey = apiKey;
    this.timeout = timeout;
    this.transport = transport;
  }

  /**
   * Answers named questions while preserving probabilities, model, and usage.
   * @param {*} state Text, JSON, or chat-message state.
   * @param {Record<string, object>} questions Nonempty mapping of question ids.
   * @param {object} [options] Per-request overrides.
   * @param {string} [options.model] Model override.
   * @param {string[]} [options.images] Image data URLs.
   * @param {string[]} [options.files] File data URLs.
   * @param {AbortSignal} [options.signal] Caller cancellation signal.
   * @param {function(Record<string, unknown>): void} [options.metricsCollector] Receives
   *   provider, model, request/response sizes, and token usage after a successful request.
   */
  async decide(
    state,
    questions,
    { model = this.model, images, files, signal, metricsCollector } = {},
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
    for (const [field, values] of [
      ['images', images],
      ['files', files],
    ]) {
      if (values !== undefined) {
        if (
          !Array.isArray(values) ||
          values.some((value) => typeof value !== 'string' || !value.startsWith('data:'))
        ) {
          throw new Error(`${field} must be an array of data URLs`);
        }
        payload[field] = [...values];
      }
    }
    let sizes;
    const response = await this.request('systemone', payload, signal, (value) => {
      sizes = value;
    });
    if (!isRecord(response.answers)) throw new Error("Server response has no 'answers' object");
    metricsCollector?.({
      provider: 'llama_decision',
      model: typeof response.model === 'string' && response.model ? response.model : model,
      ...sizes,
      usage: decisionUsage(response.usage),
    });
    return response;
  }

  /**
   * Returns the complete /v1/models response.
   * @param {object} [options] Request options.
   * @param {AbortSignal} [options.signal] Caller cancellation signal.
   */
  listModels({ signal } = {}) {
    return this.request('models', undefined, signal);
  }

  /** Decision models cannot satisfy the extension's generated-text contract. */
  complete() {
    throw Object.assign(
      new Error(
        'Decision API supports structured decisions only; use a completion provider for summaries and chat.',
      ),
      { retryable: false },
    );
  }

  /**
   * Sends one JSON request, preserving HTTP error status and raw body.
   * @param {string} endpoint Relative API endpoint.
   * @param {object} [payload] Optional POST body; absent for GET.
   * @param {AbortSignal} [signal] Caller cancellation signal.
   * @param {function({requestChars: number, responseChars: number}): void} [onSizes]
   *   Receives request and response sizes of a successful request.
   */
  async request(endpoint, payload, signal, onSizes) {
    const headers = { Accept: 'application/json' };
    if (payload !== undefined) headers['Content-Type'] = 'application/json';
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    const timeoutSignal = createRequestTimeoutSignal(this.timeout * 1000);
    const merged = mergeAbortSignals(signal, timeoutSignal.signal);
    const requestBody = payload !== undefined ? JSON.stringify(payload) : undefined;
    try {
      merged.signal.throwIfAborted();
      const response = await this.transport(`${this.baseUrl}/${endpoint}`, {
        method: payload === undefined ? 'GET' : 'POST',
        headers,
        ...(requestBody !== undefined ? { body: requestBody } : {}),
        signal: merged.signal,
      });
      if (!response.ok) {
        const body = await response.text();
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch (_) {
          parsed = null;
        }
        throw Object.assign(new Error(`llama.cpp returned HTTP ${response.status}: ${body}`), {
          status: response.status,
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
      if (!isRecord(result)) throw new Error('Server response must be a JSON object');
      // Re-serialized size; whitespace may differ from the wire body.
      onSizes?.({
        requestChars: requestBody?.length ?? 0,
        responseChars: JSON.stringify(result).length,
      });
      return result;
    } finally {
      timeoutSignal.dispose();
      merged.dispose();
    }
  }
}
