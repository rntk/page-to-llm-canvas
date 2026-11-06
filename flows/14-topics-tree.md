# Topics tree

The topics tree lays out a completed record's topics as a progressive-disclosure tree on a pan/zoom canvas: the article is the root, branch topics are nodes with their summaries, and the deepest topics are leaf cards with their summary and source sentences. The view starts with the top-level topics visible. Clicking a topic unfolds or folds it (optionally one branch at a time), and its sentence count unfolds the whole branch. The view controls (one branch at a time, level switcher, Fit) sit in the page bar beside the title to leave the canvas more room. Leaf cards can be moved and resized. **Show in page** on a card opens the topics rail at that topic's sentences, as the hierarchy view does.

Like the [hierarchy](09-hierarchy.md), the topics tree is **aggregated**: it is built on [`buildTopicTree`](../src/domain/topicTree.js), so each unique topic path is one node, unlike the chronological [canvas](08-canvas.md) cards. Branch title sizes grow with the share of the article's sentences the topic covers.

Node sizes are measured from the DOM and placed by a contour-based tidy layout in [`treeLayout.js`](../src/topics-tree/treeLayout.js), so the layout follows the rendered text. The display tree and its expand/collapse rules are pure functions in [`topicsTreeModel.js`](../src/topics-tree/topicsTreeModel.js).

The **Topics** switcher in the header chooses which topics and summaries are shown: the pipeline's, or the [summary tree](15-summary-tree.md) built beside them. The summary tree is laid out from its saved structure rather than from topic paths: passages are the leaf cards, and the root carries the article overview. Its status bar starts, stops, resumes and rebuilds the build; the canvas is hidden while a build is running.

The view opens in the same record iframe as the canvas, with `view=tree` selecting the topics tree app. It is opened from the popup's **Tree** button.

Entrypoint: [`src/canvas/main.jsx`](../src/canvas/main.jsx) (which selects and renders [`TopicsTreeApp`](../src/topics-tree/TopicsTreeApp.jsx) for the tree route)
