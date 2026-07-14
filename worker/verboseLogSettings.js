// Persisted verbose diagnostics toggle. When enabled, the orchestrator writes
// a processingLog entry (and console.info) for every stage — including
// per-chunk / per-topic LLM request and response events — and article chat
// logs its per-chunk/tool details to the page console. When disabled, only
// high-level lifecycle and error stages are recorded, which keeps consoles and
// the record's processingLog much quieter.
//
// Stored in chrome.storage.local so both the options UI (src/options) and the
// service-worker pipeline (worker/orchestrator) can read it. Defaults to off
// (quiet), and every accessor degrades to the default rather than throwing so
// a storage hiccup never breaks the pipeline.

export * from '../verboseLogSettings.js';
