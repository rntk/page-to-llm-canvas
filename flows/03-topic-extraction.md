# Topic extraction

Topic extraction groups source sentences into named topics and nested topic paths. The topic-range input is bounded into LLM-sized chunks; responses are parsed, normalized, repaired for coverage, and combined back into article-level sentence ranges. Oversized ranges are then refined by re-querying the model: one range can fan out into several requests — one per chunk of its tagged text, a fixed-size window fallback when a re-split makes no progress, and one further level of recursion — so refinement is bounded but not a single follow-up call.

The stage persists sentences and topics before summary generation begins. Parsed chunk results are also kept in a durable `topic_range_chunks` checkpoint, keyed to the record's content revision, so a resumed or retried run only re-requests the chunks it still needs. This checkpoint allows summary work to resume without recomputing the page analysis, while the topic hierarchy supplies the structure used by every view.

Entrypoint: [`src/core/pipeline/topicRangesStage.js`](../src/core/pipeline/topicRangesStage.js) (refinement: [`src/core/pipeline/topicRangeResplit.js`](../src/core/pipeline/topicRangeResplit.js))
