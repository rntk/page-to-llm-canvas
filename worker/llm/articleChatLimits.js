import {
  getPipelineTextChunkMaxChars,
  PIPELINE_TEXT_CHUNK_MAX_CHARS,
} from '../pipeline/pipelineConfig.js';
import {
  ARTICLE_CHAT_MAX_CHUNK_CHARS,
  ARTICLE_CHAT_MAX_HISTORY_CHARS,
} from '../settings/articleChatBudget.js';

/**
 * Derives the variable-text budgets for one article-chat request. The pipeline
 * function supplies the conservative provider/context calculation; chat then
 * divides that budget between source and replayed conversation so their sum,
 * rather than either field independently, fits a small context window. A
 * provider that declares no window keeps the established defaults, which the
 * pipeline signals by returning its own full-budget fallback.
 * @param {unknown} contextWindowTokens
 * @returns {{maxChunkChars: number, maxHistoryChars: number}}
 */
export function getArticleChatLimits(contextWindowTokens) {
  const textBudget = getPipelineTextChunkMaxChars(contextWindowTokens);
  if (textBudget >= PIPELINE_TEXT_CHUNK_MAX_CHARS) {
    return {
      maxChunkChars: ARTICLE_CHAT_MAX_CHUNK_CHARS,
      maxHistoryChars: ARTICLE_CHAT_MAX_HISTORY_CHARS,
    };
  }
  const maxHistoryChars = Math.min(ARTICLE_CHAT_MAX_HISTORY_CHARS, Math.floor(textBudget / 3));
  return {
    maxChunkChars: Math.max(1, textBudget - maxHistoryChars),
    maxHistoryChars,
  };
}
