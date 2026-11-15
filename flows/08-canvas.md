# Canvas

The canvas is the main full-screen exploration surface for a completed record. It loads the saved article, topics, summaries, and source sentences into a pan/zoom layout, with a topic rail, summary mode, source highlighting, topic navigation, and keyboard-friendly movement between cards.

Canvas topic cards are **chronological**. Each topic's sentences are split into contiguous runs, and each run becomes its own card, ordered by source position (see [`buildTopicHierarchyTree`](../src/domain/topicDomain.js) and [`buildTopicCards`](../src/domain/topicCards.js)). The [hierarchy view](09-hierarchy.md) shows an aggregated one-node-per-path outline instead, so the same record can be laid out differently in the two views. This is intended.

The **Topics** switcher at the top left of a completed record chooses whose topics and summaries the canvas lays out: the pipeline's, or the [summary tree](15-summary-tree.md) built beside them. The summary tree is converted to the record's topic shape by [`projectSummaryTreeTopics`](../src/domain/summaryTreeTopicProjection.js), so the same chronological builders lay it out: its passages become the leaf topic cards and its topics their parents. The root overview is not shown. While the tree is missing or still building, a status message replaces the canvas, and the bar beside the switcher builds, stops, resumes or rebuilds it. Resplit is not offered for summary tree topics, and switching sources resets the topic selection and chat. Source state is shared with the other views in [`topicSource.js`](../src/shared/topicSource.js).

Canvas interactions can reveal the source sentences behind a topic and open article chat in the same surface. The content script owns the iframe and surface lifetime; the canvas bundle owns the view state and record presentation.

Entrypoint: [`src/canvas/main.jsx`](../src/canvas/main.jsx)
