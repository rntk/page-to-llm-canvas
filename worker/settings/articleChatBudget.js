// Established article-chat text budgets, used when the active provider declares
// no context window. They live in a dependency-free module because both the
// content-script turn loop and the background limit resolver must agree on
// them: the resolver detects "no declared window" by comparing the pipeline's
// budget against ARTICLE_CHAT_MAX_CHUNK_CHARS, so a silent drift between the
// two would hand every unknown provider a small-window split.
export const ARTICLE_CHAT_MAX_CHUNK_CHARS = 60_000;
export const ARTICLE_CHAT_MAX_HISTORY_CHARS = 24_000;
