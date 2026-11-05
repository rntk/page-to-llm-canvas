# Topics tree

The topics tree lays out a completed record's topics as a progressive-disclosure tree on a pan/zoom canvas: the article is the root, branch topics are nodes with their summaries, and the deepest topics are leaf cards with their summary and source sentences. The view starts with the top-level topics visible. Clicking a topic unfolds or folds it (optionally one branch at a time), and its sentence count unfolds the whole branch. A level switcher, Expand all, Fit and Reset control the view. Leaf cards can be moved and resized, and **Tidy** undoes those manual edits. **Show in page** on a card opens the topics rail at that topic's sentences, as the hierarchy view does.

Like the [hierarchy](09-hierarchy.md), the topics tree is **aggregated**: it is built on [`buildTopicTree`](../src/domain/topicTree.js), so each unique topic path is one node, unlike the chronological [canvas](08-canvas.md) cards. Branch title sizes grow with the share of the article's sentences the topic covers.

Node sizes are measured from the DOM and placed by a contour-based tidy layout in [`treeLayout.js`](../src/topics-tree/treeLayout.js), so the layout follows the rendered text. The display tree and its expand/collapse rules are pure functions in [`topicsTreeModel.js`](../src/topics-tree/topicsTreeModel.js).

The view opens in the same record iframe as the canvas, with `view=tree` selecting the topics tree app. It is opened from the popup's **Tree** button.

Entrypoint: [`src/canvas/main.jsx`](../src/canvas/main.jsx) (which selects and renders [`TopicsTreeApp`](../src/topics-tree/TopicsTreeApp.jsx) for the tree route)
