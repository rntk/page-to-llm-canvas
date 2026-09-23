# Record lifecycle and recovery

Saved records are the durable boundary between the UI, the service worker, and the analysis pipeline. The background handlers create, read, update, reprocess, retry, resume-summary work, cancel, import, and delete records. Pipeline updates include status, stage progress, checkpoints, errors, and processing logs. Retry and Skip both build on the durable per-stage caches (`topic_range_chunks`, `source_summary_units`), which are only reused while the record's content revision still matches, so recovery re-requests just the missing work.

The supervisor prevents duplicate runs, keeps the MV3 worker alive while work is active, and can recover in-flight records after worker restarts. Run IDs and compare-and-swap updates ensure a cancelled or superseded run cannot overwrite the newer run. Views treat `done`, in-progress, error, and needs-attention records differently.

Entrypoint: [`src/extension/background/handlers/recordHandlers.js`](../src/extension/background/handlers/recordHandlers.js)
