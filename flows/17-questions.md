# Questions

The questions view is a reader-driven outline of a completed article, available from the **Topics** switcher in [Canvas](08-canvas.md), [Hierarchy](09-hierarchy.md), and [Topics Tree](14-topics-tree.md). All three views load the same saved question tree for the article's current content.

Instead of splitting the text by subject labels, it splits consecutive passages by the implicit questions a reader asks as the text unfolds — including broad structural questions such as _"Why should I read this?"_ or _"So what should I do?"_. When an article yields more than seven questions, consecutive questions are grouped under broader questions.

Readers explore the result progressively across four levels:

- **Group question** (when present) — broader question and synthesized answer over consecutive sections.
- **Question** — the question that a section answers, with a short grounded answer.
- **Point** — supporting facts or confirmations cited from the section's sentences, showing the quoted source text.
- **Source** — clicking any node navigates to its cited sentences in the page rail.

The worker builds the tree in [`questionTreeStage.js`](../src/core/pipeline/questionTreeStage.js), and the views convert it into topic paths with [`questionTreeTopicProjection.js`](../src/domain/questionTreeTopicProjection.js).

Builds run as background jobs in the worker, sharing the same checkpoint, stale detection, resume, and stop lifecycle as the [summary tree](15-summary-tree.md).
