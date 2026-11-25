# Canvas

The canvas is the main full-screen exploration surface for a completed record. It loads the saved article, topics, summaries, and source sentences into a pan/zoom layout, with a topic rail, summary mode, source highlighting, topic navigation, and keyboard-friendly movement between cards.

Canvas topic cards are **chronological**. Each topic's sentences are split into contiguous runs, and each run becomes its own card, ordered by source position (see [`buildTopicHierarchyTree`](../src/domain/topicDomain.js) and [`buildTopicCards`](../src/domain/topicCards.js)). The [hierarchy view](09-hierarchy.md) shows an aggregated one-node-per-path outline instead, so the same record can be laid out differently in the two views. This is intended.

The **Topics** switcher at the top left of a completed record offers **Pipeline**, **Summary tree**, and **Questions**. The [summary tree](15-summary-tree.md) projects topics and passages onto the chronological canvas and omits its root overview. The [questions view](17-questions.md) uses the same chronological layout for question groups, questions, and supporting points. Summaries show answers and cited text, and cards highlight the corresponding article sentences.

Questions already generated in any view are loaded from the saved record. If the selected tree is missing or still building, a status message takes the place of the canvas and the bar offers the applicable build controls. **Rebuild** explicitly starts over. Switching sources resets topic selection and chat, and **Resplit** is available on pipeline topics. Source state is shared with the other views in [`topicSource.js`](../src/shared/topicSource.js).

Canvas interactions can reveal the source sentences behind a topic and open article chat in the same surface. The content script owns the iframe and surface lifetime; the canvas bundle owns the view state and record presentation.

Entrypoint: [`src/canvas/main.jsx`](../src/canvas/main.jsx)
