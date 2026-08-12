// Stable validation bounds for the persisted provider context-window setting.
// Prompt growth must not silently invalidate values that were accepted and
// stored by an earlier extension version. Pipeline tests verify that the fixed
// minimum still has enough room for every prompt template.
export const PIPELINE_MIN_CONTEXT_WINDOW_TOKENS = 4096;
export const PROVIDER_MAX_CONTEXT_WINDOW_TOKENS = 10_000_000;
