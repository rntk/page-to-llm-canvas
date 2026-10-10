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
 * Own provider dispatch, measurement, budgets, and request cache identities.
 * The limiter belongs to the composition root and is shared across all runs.
 * @param {object} deps Provider factories, telemetry, and shared limiter.
 * @returns {Function} Binds provider capabilities to a single run's snapshot.
 */
export function createPipelineProviderServices({ llm, telemetry, limiter }) {
  const measuredCompletion = telemetry.wrapCallLLMWithRetry(llm.callLLMWithRetry);
  const measureDecide = telemetry.wrapDecide ?? ((decide) => decide);

  return ({ activeProvider, key, verboseLogs }) => {
    // Completion retries hold one slot, including backoff. Decision transport
    // attempts enter separately; boundary policy owns their retry/shrink loop.
    const callLLMWithRetry = (opts, maxRetries) =>
      limiter.run(
        () => measuredCompletion({ ...opts, provider: activeProvider }, maxRetries),
        opts?.signal,
        { providerKey: providerQueueKey(activeProvider), fairnessKey: key },
      );

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

      // Only primary splitting needs a decision client. Summary resumes and
      // manual resplits must not depend on an unrelated provider's configuration.
      createTopicSplitter(decisionProvider) {
        if (!decisionProvider) return createCompletionTopicSplitter({ callLLMWithRetry });
        if (!llm.createDecisionClient) {
          throw new Error('The selected topic splitter has no Decision API client factory');
        }
        let client;
        try {
          client = llm.createDecisionClient(decisionProvider);
        } catch (error) {
          throw new Error(
            `Topic splitter "${decisionProvider.name}" is misconfigured: ${error?.message || error}`,
          );
        }
        const measuredDecide = measureDecide(
          (state, questions, opts) => client.decide(state, questions, { ...opts, verboseLogs }),
          { model: decisionProvider.model },
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
        });
      },
    };
  };
}
