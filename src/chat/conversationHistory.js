import { ARTICLE_CHAT_MAX_HISTORY_CHARS } from '../core/settings/llmBudgets.js';

export const CHAT_HISTORY_MAX_MESSAGES = 20;
export const CHAT_HISTORY_MAX_CHARS = ARTICLE_CHAT_MAX_HISTORY_CHARS;

/**
 * Keep only recent user-visible conversation context. Historical tool calls
 * are persisted for auditability, but replaying every chunk's calls into every
 * later chunk multiplies token usage and gives the model irrelevant ranges.
 * @param {object[]} history Persisted conversation history.
 * @param {number} [maxChars] Maximum history characters for this request.
 * @returns {Array<{role: string, content: string}>}
 */
export function compactConversationHistory(history, maxChars = CHAT_HISTORY_MAX_CHARS) {
  const source = (Array.isArray(history) ? history : []).filter(
    (message) =>
      ['user', 'assistant'].includes(message?.role) &&
      !Array.isArray(message.toolCalls) &&
      String(message.content || '').trim(),
  );
  const kept = [];
  let remainingChars = Math.min(
    CHAT_HISTORY_MAX_CHARS,
    Number.isFinite(maxChars) && maxChars >= 0 ? Math.floor(maxChars) : 0,
  );
  for (
    let index = source.length - 1;
    index >= 0 && kept.length < CHAT_HISTORY_MAX_MESSAGES;
    index -= 1
  ) {
    if (remainingChars <= 0) break;
    const message = source[index];
    const content = String(message.content || '')
      .trim()
      .slice(0, remainingChars);
    if (!content) continue;
    kept.push({ role: message.role, content });
    remainingChars -= content.length;
  }
  return kept.reverse();
}
