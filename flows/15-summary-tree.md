# Summary tree

The summary tree is an alternate, hierarchical view of a completed article. It sits beside the article's primary topics and summaries, which remain unchanged. Readers move from an article overview through progressively narrower topics and summaries to the cited source sentences.

The tree is built from source passages and the article's existing topic structure. Its summaries provide orientation at each level; citations connect claims back to the original text. The tree can be built or rebuilt independently of the article's processing pipeline, and the saved result can be resumed after an interruption.

The [topics tree](14-topics-tree.md) is the main place to view and manage an article's summary tree. The [project canvas](16-project-canvas.md) uses the same approach to organize topics from multiple saved articles.

Entry points: [summary tree pipeline](../src/core/pipeline/summaryTreeStage.js) and [topics tree view](../src/topics-tree/TopicsTreeApp.jsx).
