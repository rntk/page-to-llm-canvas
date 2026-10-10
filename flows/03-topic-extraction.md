# Topic extraction

Topic extraction groups source sentences into named topics and nested topic paths. The topic stage prepares the source once and invokes one of two interchangeable splitters:

- **Completion splitting:** bounded sentence chunks are sent to the completion LLM. Responses are parsed, normalized, repaired for coverage, and combined into article-level ranges.
- **Decision splitting:** the selected Decision API provider classifies gaps between sentences. Ranges are assembled deterministically, then the completion LLM names them. Artificial cuts inside a long sentence are rejoined before boundary decisions.

Both implementations return labelled groups in the same sentence coordinate system. The stage commits sentences and topics before summaries begin. Intermediate work is persisted in `topic_range_chunks`: parsed chunks for completion splitting, or successful boundary answers and labels for decision splitting. Each strategy validates its own checkpoint before reuse. The final topic write clears this work document and establishes the summary checkpoint.

There is no automatic refinement pass. The user can choose **Resplit** from a topic card on the canvas. This operation uses the completion splitter with hierarchy context over the selected range, even when primary splitting uses decisions. It replaces that topic and its subtopics within the range; only summaries covering replaced sentences are regenerated.

Entrypoint: [`topicRangesStage.js`](../src/core/pipeline/topicRangesStage.js). Strategy composition: [`topicSplitter.js`](../src/core/pipeline/topicSplitter.js). Implementations: [`topicRangeSplit.js`](../src/core/pipeline/topicRangeSplit.js), [`decisionTopicSplit.js`](../src/core/pipeline/decisionTopicSplit.js). Manual resplit: [`topicRangeResplit.js`](../src/core/pipeline/topicRangeResplit.js), [`topicResplitApply.js`](../src/core/pipeline/topicResplitApply.js).

See [Pipeline composition](./13-pipeline-composition.md) for ownership, recovery contracts, and extension guidance.
