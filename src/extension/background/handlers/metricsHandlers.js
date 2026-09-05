import { MSG } from '../../../shared/runtime/messages.js';

/**
 * Handlers for metric samples produced outside the worker realm, and for the
 * clears that must serialize against the worker's own metric writes.
 *
 * @param {object} deps
 * @param {Function} deps.recordChatToolMetric
 * @param {Function} deps.clearChatToolMetrics
 * @param {Function} deps.clearParserMetrics
 * @param {Function} deps.clearResplitMetrics
 */
export function createMetricsHandlers({
  recordChatToolMetric,
  clearChatToolMetrics,
  clearParserMetrics,
  clearResplitMetrics,
}) {
  return {
    // Records the outcome of one article-chat highlight_span tool call. The
    // classification happens page-side (in articleChat.js) but chat mounts in
    // content scripts too, so recording is centralized here in the worker.
    // Terminal handler: await the write so it is not dropped on SW suspension.
    [MSG.recordChatToolMetric]: {
      requiresExtensionPage: false,
      validate: () => null,
      async handle(msg) {
        await recordChatToolMetric({ outcome: msg.outcome, error: msg.error });
        return { ok: true };
      },
    },

    // Clearing runs in the worker (not the options realm) so it serializes on the
    // same writeChain as recordChatToolMetric — otherwise an in-flight worker
    // record could restore the pre-clear aggregate after an options-side clear.
    [MSG.clearChatToolMetrics]: {
      requiresExtensionPage: true,
      validate: () => null,
      async handle() {
        await clearChatToolMetrics();
        return { ok: true };
      },
    },

    // Parser and resplit samples are also produced in the worker. Route their
    // clears through this realm so each clear shares the same serialized metrics
    // queue as its in-flight record writes.
    [MSG.clearParserMetrics]: {
      requiresExtensionPage: true,
      validate: () => null,
      async handle() {
        await clearParserMetrics();
        return { ok: true };
      },
    },

    [MSG.clearResplitMetrics]: {
      requiresExtensionPage: true,
      validate: () => null,
      async handle() {
        await clearResplitMetrics();
        return { ok: true };
      },
    },
  };
}
