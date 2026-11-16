import { MSG } from '../../../shared/runtime/messages.js';

/**
 * Handlers for metric samples produced outside the worker realm, and for the
 * clears that must serialize against the worker's own metric writes.
 *
 * @param {object} deps
 * @param {Function} deps.recordChatToolMetric
 * @param {Function} deps.clearChatToolMetrics
 * @param {Function} deps.clearParserMetrics
 */
export function createMetricsHandlers({
  recordChatToolMetric,
  clearChatToolMetrics,
  clearParserMetrics,
}) {
  return {
    // Records one article-chat highlight_span tool call outcome. Classified
    // page-side but recorded here since chat mounts in content scripts too.
    // Awaited so the write is not dropped on worker suspension.
    [MSG.recordChatToolMetric]: {
      requiresExtensionPage: false,
      validate: () => null,
      async handle(msg) {
        await recordChatToolMetric({ outcome: msg.outcome, error: msg.error });
        return { ok: true };
      },
    },

    // Clears run in the worker so they serialize on the same writeChain as
    // recordChatToolMetric; an in-flight record could otherwise restore the old aggregate.
    [MSG.clearChatToolMetrics]: {
      requiresExtensionPage: true,
      validate: () => null,
      async handle() {
        await clearChatToolMetrics();
        return { ok: true };
      },
    },

    // Parser samples are also produced in the worker; clear them here to share
    // the serialized metrics queue with in-flight writes.
    [MSG.clearParserMetrics]: {
      requiresExtensionPage: true,
      validate: () => null,
      async handle() {
        await clearParserMetrics();
        return { ok: true };
      },
    },
  };
}
