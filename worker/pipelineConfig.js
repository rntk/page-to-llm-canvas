// Topic-range input includes sentence markers while source-summary input is raw
// text, so the stages keep distinct semantic names. They intentionally share
// one budget to keep request sizing consistent across the pipeline.
const PIPELINE_TEXT_CHUNK_MAX_CHARS = 60000;

export const MAX_TAGGED_CHARS = PIPELINE_TEXT_CHUNK_MAX_CHARS;
export const SOURCE_SUMMARY_MAX_CHARS = PIPELINE_TEXT_CHUNK_MAX_CHARS;

// Leaf summaries and internal-node source summaries share one concurrency cap;
// together they form the provider-facing summary workload.
export const SUMMARY_CONCURRENCY = 4;
