import { LLM_TEXT_FALLBACK_MAX_CHARS } from './textBudget.js';

// Fallback shares of the neutral variable-text budget, used when the active
// provider declares no context window. Derivation makes it impossible for the
// source and history allowances to drift beyond the shared ceiling.
export const ARTICLE_CHAT_MAX_HISTORY_CHARS = Math.floor(LLM_TEXT_FALLBACK_MAX_CHARS / 3);
export const ARTICLE_CHAT_MAX_CHUNK_CHARS =
  LLM_TEXT_FALLBACK_MAX_CHARS - ARTICLE_CHAT_MAX_HISTORY_CHARS;
