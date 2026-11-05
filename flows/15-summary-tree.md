# Summary tree

The summary tree is an alternative topics-and-summaries approach, built beside a completed record's primary topics and summaries. It never replaces them: the [topics tree](14-topics-tree.md) switches between the two. Each level down is more specific and more detailed, ending at cited source sentences.

```
root (article)         one or two segments naming the main topics
├─ Topic               abstract overview of its sub-topics
│  ├─ Sub-topic        detailed summary: names, numbers, disagreements
│  │  ├─ passage       brief summary → cited sentences
│  │  └─ passage
│  └─ Sub-topic
└─ Topic
```

Stages:

1. **Passages:** the article is cut into contiguous passages (about 1,500 characters, preferring the primary topics' boundaries). Every passage gets a brief summary and a short title, each segment citing sentence numbers. Passages without substance return no segments and are skipped; a passage that never gets a valid answer is marked failed instead of failing the build.
2. **Topics:** only the short passage digests are sent to the completion model, which splits them into 2–7 distinct sub-topics one level more specific than the current path. A topic with more than four passages is split again, up to three levels. Large sets are grouped in batches against the topics found so far. Invalid answers are rejected, unassigned passages go to "Other", and when no real split is found the passages stay directly under the topic.
3. **Summaries:** bottom-up along that structure, with one intent per level: `detail` just above passages, `overview` for topics of topics, `root` for the article. Every segment cites child claims (`C1.S2`), so any statement resolves down to sentence numbers. A topic with a single child reuses that child's prose.

Every substantive segment needs valid local citations; unknown and out-of-range references reject the answer. An invalid answer is retried up to three times. Three consecutive provider outages, or a permanent provider error, fail the build.

When a Decision API provider is selected as the topic splitter, it acts as an optional judge. The completion model proposes sub-topic titles once, and typed questions then assign each passage (a choice over the titles plus a yes/no "fits any"). Claims at the passage and detail levels are checked against what they cite: unsupported claims are dropped, and an answer whose every claim is unsupported is rejected. Any decision failure switches the judge off for the rest of the build, and the completion-only path is used instead.

The build runs from the topics tree (**Build summary tree**, **Stop**, **Resume**, **Rebuild**) and only for a completed record. It is not an in-flight pipeline run: the record stays `done` and usable in every view. The build owns the record only while its run id is current, so any newer run (Retry, Reprocess, Resplit) supersedes it. Failures are stored on the tree, never on the record. Completed nodes are checkpointed in the record's `summary_tree` (stored with `topic_summary_index`). **Resume** reuses them while the content revision and provider identity match; **Rebuild** starts over. Builds are not resumed automatically after the service worker restarts. A running tree that has not saved for a minute is shown as interrupted and can be resumed.

Entrypoint: [`summaryTreeStage.js`](../src/core/pipeline/summaryTreeStage.js) (prompts: [`summaryTreePrompts.js`](../src/core/pipeline/summaryTreePrompts.js); topics: [`summaryTreeTopics.js`](../src/core/pipeline/summaryTreeTopics.js); summaries: [`summaryTreeGeneration.js`](../src/core/pipeline/summaryTreeGeneration.js)). Worker side: `runSummaryTree` in [`orchestrator.js`](../src/extension/background/pipeline/orchestrator.js) and [`summaryTreeJobs.js`](../src/extension/background/summaryTreeJobs.js).
