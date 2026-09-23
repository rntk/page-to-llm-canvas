# Canvas

The canvas is the main full-screen exploration surface for a completed record. It loads the saved article, topics, summaries, and source sentences into a pan/zoom layout, with a topic rail, summary mode, source highlighting, topic navigation, and keyboard-friendly movement between cards.

Canvas topic cards are **chronological**. Each topic's sentences are split into contiguous runs, and each run becomes its own card, ordered by source position (see [`buildTopicHierarchyTree`](../src/domain/topicDomain.js) and [`buildTopicCards`](../src/domain/topicCards.js)). The [hierarchy view](09-hierarchy.md) shows an aggregated one-node-per-path outline instead, so the same record can be laid out differently in the two views. This is intended.

Canvas interactions can reveal the source sentences behind a topic and open article chat in the same surface. The content script owns the iframe and surface lifetime; the canvas bundle owns the view state and record presentation.

Entrypoint: [`src/canvas/main.jsx`](../src/canvas/main.jsx)
