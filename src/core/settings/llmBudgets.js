// Neutral fallback ceiling for provider-facing variable text. Provider-aware
// budgets derive downward from this value; individual LLM surfaces may divide
// it into source/history shares but must not duplicate the ceiling.
export const LLM_TEXT_FALLBACK_MAX_CHARS = 60_000;

// Stable validation bounds for the persisted provider context-window setting.
// Prompt growth must not silently invalidate values that were accepted and
// stored by an earlier extension version. Pipeline tests verify that the fixed
// minimum still has enough room for every prompt template.
export const PIPELINE_MIN_CONTEXT_WINDOW_TOKENS = 4096;
export const PROVIDER_MAX_CONTEXT_WINDOW_TOKENS = 10_000_000;

// Fallback shares of the neutral variable-text budget, used when the active
// provider declares no context window. Derivation makes it impossible for the
// source and history allowances to drift beyond the shared ceiling.
export const ARTICLE_CHAT_MAX_HISTORY_CHARS = Math.floor(LLM_TEXT_FALLBACK_MAX_CHARS / 3);
export const ARTICLE_CHAT_MAX_CHUNK_CHARS =
  LLM_TEXT_FALLBACK_MAX_CHARS - ARTICLE_CHAT_MAX_HISTORY_CHARS;
