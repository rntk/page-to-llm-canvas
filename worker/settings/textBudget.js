// Neutral fallback ceiling for provider-facing variable text. Provider-aware
// budgets derive downward from this value; individual LLM surfaces may divide
// it into source/history shares but must not duplicate the ceiling.
export const LLM_TEXT_FALLBACK_MAX_CHARS = 60_000;
