import { getPipelineTextChunkMaxChars } from '../pipeline/pipelineConfig.js';
import { ARTICLE_CHAT_MAX_HISTORY_CHARS } from '../settings/articleChatBudget.js';

/**
 * Derives article-chat budgets from the pipeline budget. The pipeline budget
 * is already estimator-derived; chat splits it between source and history so
 * their sum fits the same window. Fixed overhead and response sizes differ
 * from the pipeline, but the variable-text estimator is shared.
 * @param {unknown} contextWindowTokens
 * @returns {{maxChunkChars: number, maxHistoryChars: number}}
 */
export function getArticleChatLimits(contextWindowTokens) {
  const textBudget = getPipelineTextChunkMaxChars(contextWindowTokens);
  const maxHistoryChars = Math.min(ARTICLE_CHAT_MAX_HISTORY_CHARS, Math.floor(textBudget / 3));
  return {
    maxChunkChars: Math.max(1, textBudget - maxHistoryChars),
    maxHistoryChars,
  };
}
