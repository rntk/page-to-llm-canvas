# Summary tree

The summary tree is an alternative topics-and-summaries approach, built beside a completed record's primary topics and summaries. It never replaces them: the [topics tree](14-topics-tree.md) switches between the two. Its purpose is to separate the material and reduce what a reader needs to inspect. Each level down narrows the subject, ending at cited source sentences. Summaries are short introductions that help readers choose a branch; the source text supplies the details.

```
root (article)         orientation: subject and main areas of focus
├─ Topic               scope and main distinction among branches
│  ├─ Sub-topic        specific subject or central issue
│  │  ├─ passage       subject and one distinguishing point
│  │  │  └─ source     original passage sentences
│  │  └─ passage
│  └─ Sub-topic
└─ Topic
```

Stages:

1. **Passages:** the article is cut into contiguous passages (about 1,500 characters, preferring the primary topics' boundaries). Every passage gets a one-sentence selection hint (at most 25 words requested) and a short title, each segment citing sentence numbers. The hint keeps the specific subject and one distinguishing fact, finding or question so it also supports topic grouping. Passages without substance return no segments and are skipped; a passage that never gets a valid answer is marked failed instead of failing the build.
2. **Topics:** only the short passage digests are sent to the completion model, which splits them into 2–7 distinct sub-topics one level more specific than the current path. A topic with more than four passages is split again, up to three levels. Large sets are grouped in batches against the topics found so far. Invalid answers are rejected, unassigned passages go to "Other", and when no real split is found the passages stay directly under the topic.
3. **Summaries:** bottom-up along that structure, with one intent per level: `detail` introduces a narrow topic just above passages, `overview` introduces the scope and main distinction among sub-topics, and `root` orients the reader to the article. The prompts request one sentence of at most 30 words for `detail` and `overview`, and one or two sentences of at most 40 words for `root`. Budgets cover all segment text for a node, excluding titles and citations; shorter evidence should produce shorter hints. Summaries avoid repeating titles, listing every child, or collecting supporting details. Attribution, uncertainty and disagreement remain where needed to keep the selected claims accurate. Every segment cites child claims (`C1.S2`), so any statement resolves down to sentence numbers. A topic with a single child reuses that child's prose.

These length budgets guide generation; they are not enforced by truncating prose or rejecting answers. Existing saved summaries are reused on **Resume**; use **Rebuild** to regenerate a completed tree with the current prompts.

Every substantive segment needs valid local citations; unknown and out-of-range references reject the answer. An invalid answer is retried up to three times. Three consecutive provider outages, or a permanent provider error, fail the build.

When a Decision API provider is selected as the topic splitter, it acts as an optional judge. The completion model proposes sub-topic titles once, and typed questions then assign each passage (a choice over the titles plus a yes/no "fits any"). Claims at the passage and detail levels are checked against what they cite: unsupported claims are dropped, and an answer whose every claim is unsupported is rejected. Any decision failure switches the judge off for the rest of the build, and the completion-only path is used instead.

Folding and unfolding a branch is animated (about 260 ms) so the change is easy to follow: nodes glide to their new places and the view moves with them to keep the clicked topic still, new nodes and links grow out of their parent, and hidden ones shrink back into the node that replaces them. Dragging a card, panning and the first layout are never animated, and the OS "reduce motion" setting turns the animation off. The article and project trees share this behavior ([`treeMotion.js`](../src/topics-tree/treeMotion.js)).

The build runs from the topics tree (**Build summary tree**, **Stop**, **Resume**, **Rebuild**) and only for a completed record. It is not an in-flight pipeline run: the record stays `done` and usable in every view. The build owns the record only while its run id is current, so any newer run (Retry, Reprocess, Resplit) supersedes it. Failures are stored on the tree, never on the record. Completed nodes are checkpointed in the record's `summary_tree` (stored with `topic_summary_index`). **Resume** reuses them while the content revision and provider identity match; **Rebuild** starts over. Builds are not resumed automatically after the service worker restarts. A running tree that has not saved for a minute is shown as interrupted and can be resumed.

The [project canvas](16-project-canvas.md#project-actions) also uses this tree UI and pipeline to merge primary topics across its saved pages. That build starts from the existing primary topics rather than splitting a synthetic combined article. Its source cards identify each article and display that article's own sentence numbers; the project snapshot stores the mapping from internal global rows back to the source record and local line. The merged tree is saved on the project, independently of the article trees.

Entrypoint: [`summaryTreeStage.js`](../src/core/pipeline/summaryTreeStage.js) (prompts: [`summaryTreePrompts.js`](../src/core/pipeline/summaryTreePrompts.js); topics: [`summaryTreeTopics.js`](../src/core/pipeline/summaryTreeTopics.js); summaries: [`summaryTreeGeneration.js`](../src/core/pipeline/summaryTreeGeneration.js)). Worker side: `runSummaryTree` in [`orchestrator.js`](../src/extension/background/pipeline/orchestrator.js) and [`summaryTreeJobs.js`](../src/extension/background/summaryTreeJobs.js).
