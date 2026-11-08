// Completion and decision requests of the summary tree. An answer is accepted
// only after validation; invalid answers are retried a bounded number of times.
// Decision failures never become answers: the judge switches itself off for the
// rest of the run and callers fall back to the completion path.

import { executeDecisionWithRetry } from '../llm/decisionRetry.js';
import { parallelMap } from '../llm/concurrency.js';
import { LLM_TASK_TYPES } from '../metrics/llm.js';
import { isCancellationError } from './cancellation.js';
import { isPermanentProviderError, markProviderFailure } from './providerFailure.js';
import { SUMMARY_PROVIDER_MAX_ATTEMPTS } from './pipelineConfig.js';

export const ANSWER_ATTEMPTS = 3; // invalid answers per prompt before giving up
export const MAX_OUTAGE_ASKS = 3; // consecutive asks without any answer before the run fails
export const JUDGE_WORKERS = 4;

/**
 * Raised when the provider keeps failing or rejects requests permanently.
 */
export class SummaryTreeProviderError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = 'SummaryTreeProviderError';
  }
}

/**
 * @param {object} input
 * @param {Function} input.callLLMWithRetry Shared-limiter completion request.
 * @param {AbortSignal} [input.signal] Run cancellation.
 * @param {object} [input.runtime] Owner of the cancellation signal.
 */
export function createSummaryTreeLlm({ callLLMWithRetry, signal, runtime }) {
  const metrics = { calls: 0, invalidAnswers: 0, failures: 0 };
  let outages = 0;

  /**
   * Ask until `accept(raw)` returns true. Resolves false when every answer was
   * invalid or the provider failed this ask; throws on cancellation, permanent
   * provider errors, and repeated outages.
   * @param {string} prompt
   * @param {function(string): (boolean|Promise<boolean>)} accept
   * @param {string} [taskType]
   * @returns {Promise<boolean>}
   */
  async function ask(prompt, accept, taskType = LLM_TASK_TYPES.SUMMARY_TREE_SUMMARY) {
    for (let attempt = 0; attempt < ANSWER_ATTEMPTS; attempt++) {
      signal?.throwIfAborted();
      let raw;
      try {
        metrics.calls++;
        raw = await callLLMWithRetry({ prompt, signal, taskType }, SUMMARY_PROVIDER_MAX_ATTEMPTS);
      } catch (error) {
        if (isCancellationError(error, runtime) || signal?.aborted) throw error;
        metrics.failures++;
        if (isPermanentProviderError(error)) {
          throw markProviderFailure(
            new SummaryTreeProviderError(error?.message || 'LLM request failed', error),
          );
        }
        outages++;
        if (outages >= MAX_OUTAGE_ASKS) {
          throw markProviderFailure(
            new SummaryTreeProviderError(
              `The model failed ${outages} requests in a row: ${error?.message || error}`,
              error,
            ),
          );
        }
        return false;
      }
      outages = 0;
      if (await accept(raw)) return true;
      metrics.invalidAnswers++;
    }
    return false;
  }

  return { ask, metrics };
}

/**
 * Typed questions through the decision provider, or an inactive judge when
 * none is configured.
 * @param {object} input
 * @param {Function|null} input.decide `(state, questions, options)` shared-limiter request.
 * @param {AbortSignal} [input.signal] Run cancellation.
 * @param {object} [input.runtime] Logs judge failures.
 * @param {number} [input.workers] Local request concurrency.
 */
export function createSummaryTreeJudge({ decide, signal, runtime, workers = JUDGE_WORKERS }) {
  const metrics = { calls: 0, failures: 0 };
  let active = typeof decide === 'function';

  /**
   * @param {object} state
   * @param {Record<string, object>} questions
   * @returns {Promise<object|null>} Answers by question id; null after a failure.
   */
  async function ask(state, questions) {
    if (!active) return null;
    try {
      const response = await executeDecisionWithRetry(
        () => {
          metrics.calls++;
          return decide(state, questions, {
            signal,
            taskType: LLM_TASK_TYPES.SUMMARY_TREE_DECISIONS,
          });
        },
        { signal },
      );
      const answers = response?.answers;
      if (!answers || Object.keys(questions).some((name) => !answers[name])) {
        throw new Error('Decision response is missing answers');
      }
      return answers;
    } catch (error) {
      if (isCancellationError(error, runtime) || signal?.aborted) throw error;
      metrics.failures++;
      if (active) {
        active = false;
        await runtime?.log('summary_tree_decisions_disabled', {
          error: String(error?.message ?? error).slice(0, 500),
        });
      }
      return null;
    }
  }

  return {
    get active() {
      return active;
    },
    metrics,
    ask,
    /**
     * @param {Array<[object, Record<string, object>]>} requests
     * @returns {Promise<Array<object|null>>} Answers in request order.
     */
    askMany(requests) {
      return parallelMap(requests, workers, ([state, questions]) => ask(state, questions));
    },
  };
}
