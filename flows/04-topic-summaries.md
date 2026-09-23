# Topic summaries

Summary generation builds a topic tree from source sentence ranges. Each node is split into contiguous runs, so separate appearances of a topic have separate summaries. Paths without children get resumable per-topic checkpoints. A path with children is resolved in the tree pass; its own sentences are not summarized in a separate leaf request.

A parent run wholly owned by one child reuses that child's run. A run spanning multiple children, or containing the parent's own sentences, is summarized from its original source sentences. Short runs of at most 70 words and 560 characters are shown verbatim. Larger runs are sent to the model, with bounded chunking and merging where needed. The empty root path is never summarized.

Successful source-summary units are cached for retry while the content revision and input fingerprint match. The `topic_summary_index` is the view projection for every path. Leaf checkpoints remain in `topic_summaries` for run-level retry and Skip decisions. A provider failure parks the record for review; Retry reuses completed work, and Skip accepts selected failed runs as empty while leaving them retryable on a later regeneration.

Entrypoint: [`src/core/pipeline/summaryStage.js`](../src/core/pipeline/summaryStage.js) (tree resolution: [`src/core/pipeline/topicTreeMerge.js`](../src/core/pipeline/topicTreeMerge.js))
