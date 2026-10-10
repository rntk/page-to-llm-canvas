import {
  createCompletionTopicSplitter,
  createDecisionTopicSplitter,
} from '../../../core/pipeline/topicSplitter.js';
import {
  getPipelineTextChunkMaxChars,
  getTopicRangeInputMaxSentences,
} from '../../../core/pipeline/pipelineConfig.js';
import { resolveMaxOutputTokens } from '../../../core/llm/outputBudget.js';
import { resolveProviderTemperature } from '../../../core/llm/temperatures.js';
import { LLM_TASK_TYPES } from '../../../core/metrics/llm.js';

function providerQueueKey(provider) {
  return provider?.url
    ? new URL(provider.url).href.replace(/\/+$/, '').replace(/\/v1$/, '')
    : (provider?.type ?? 'completion');
}

function providerCacheIdentity(provider) {
  return provider
    ? [
        provider.id,
        provider.type,
        provider.url ?? null,
        provider.model ?? null,
        provider.contextWindowTokens ?? null,
      ]
    : null;
}

/**
 * Own provider dispatch, measurement, budgets, request cache identities, and
 * topic-splitter selection. The limiter belongs to the composition root and is
 * shared across all runs.
 * @param {object} deps
 * @param {{getDecisionProvider: Function}} deps.providerRepository Reads the
 *   selected topic-splitter provider; null selects completion splitting.
 * @param {{callLLMWithRetry: Function, createDecisionClient: Function}} deps.llm
 *   `createDecisionClient(provider)` returns a client exposing `decide(state, questions, options)`.
 * @param {{wrapCallLLMWithRetry: Function, wrapDecide: Function}} deps.telemetry
 * @param {{run: Function}} deps.limiter Shared request limiter.
 * @returns {Function} Binds provider capabilities to a single run's snapshot.
 */
export function createPipelineProviderServices({ providerRepository, llm, telemetry, limiter }) {
  const measuredCompletion = telemetry.wrapCallLLMWithRetry(llm.callLLMWithRetry);

  return ({ activeProvider, key, verboseLogs }) => {
    // Completion retries hold one slot, including backoff. Decision transport
    // attempts enter separately; boundary policy owns their retry/shrink loop.
    const callLLMWithRetry = (opts, maxRetries) =>
      limiter.run(
        () => measuredCompletion({ ...opts, provider: activeProvider }, maxRetries),
        opts?.signal,
        { providerKey: providerQueueKey(activeProvider), fairnessKey: key },
      );

    function createDecisionSplitter(decisionProvider) {
      let client;
      try {
        client = llm.createDecisionClient(decisionProvider);
      } catch (error) {
        // Fail visibly rather than silently switching strategies.
        throw new Error(
          `Topic splitter "${decisionProvider.name}" is misconfigured: ${error?.message || error}`,
        );
      }
      const measuredDecide = telemetry.wrapDecide(
        (state, questions, opts) => client.decide(state, questions, { ...opts, verboseLogs }),
        { provider: decisionProvider.type, model: decisionProvider.model },
      );
      const decide = (state, questions, opts) =>
        limiter.run(() => measuredDecide(state, questions, opts), opts?.signal, {
          providerKey: providerQueueKey(decisionProvider),
          fairnessKey: key,
        });
      return createDecisionTopicSplitter({
        decide,
        callLLMWithRetry,
        decisionOptions: {
          contextWindowTokens: decisionProvider.contextWindowTokens,
          inputFingerprint: JSON.stringify([
            providerCacheIdentity(decisionProvider),
            providerCacheIdentity(activeProvider),
            resolveProviderTemperature(activeProvider, LLM_TASK_TYPES.TOPIC_LABELS) ?? null,
          ]),
        },
        diagnostics: {
          decisionProvider: decisionProvider.name,
          decisionModel: decisionProvider.model || '',
        },
      });
    }

    return {
      callLLMWithRetry,
      runtimeOptions: {
        maxTextChunkChars: getPipelineTextChunkMaxChars(activeProvider?.contextWindowTokens),
        maxTopicRangeSentences: getTopicRangeInputMaxSentences(
          activeProvider?.contextWindowTokens,
          resolveMaxOutputTokens(activeProvider?.contextWindowTokens),
        ),
      },
      summaryInputFingerprint: JSON.stringify([
        activeProvider?.type ?? null,
        activeProvider?.model ?? null,
        resolveProviderTemperature(activeProvider, LLM_TASK_TYPES.ARTICLE_SUMMARY) ?? null,
      ]),

      /**
       * Resolve the selected primary splitter. Only primary splitting calls this:
       * summary resumes and manual resplits never read decision-provider settings.
       * @returns {Promise<import('../../../core/pipeline/topicSplitter.js').TopicSplitter>}
       */
      async resolveTopicSplitter() {
        const decisionProvider = await providerRepository.getDecisionProvider();
        return decisionProvider
          ? createDecisionSplitter(decisionProvider)
          : createCompletionTopicSplitter({ callLLMWithRetry });
      },
    };
  };
}
