// Neutral fallback ceiling for provider-facing variable text. Provider-aware
// budgets derive downward from it; surfaces may split it into shares but must
// not duplicate the ceiling.
export const LLM_TEXT_FALLBACK_MAX_CHARS = 60_000;

// Stable validation bounds for the persisted context-window setting; prompt
// growth must not invalidate previously stored values. Pipeline tests verify
// the minimum still fits every prompt template.
export const PIPELINE_MIN_CONTEXT_WINDOW_TOKENS = 4096;
export const PROVIDER_MAX_CONTEXT_WINDOW_TOKENS = 10_000_000;

// Fallback shares of the variable-text budget when the provider declares no
// context window; derived so they cannot exceed the shared ceiling.
export const ARTICLE_CHAT_MAX_HISTORY_CHARS = Math.floor(LLM_TEXT_FALLBACK_MAX_CHARS / 3);
export const ARTICLE_CHAT_MAX_CHUNK_CHARS =
  LLM_TEXT_FALLBACK_MAX_CHARS - ARTICLE_CHAT_MAX_HISTORY_CHARS;
