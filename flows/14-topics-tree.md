# Topics tree

The topics tree lays out a completed record's topics as a progressive-disclosure tree on a pan/zoom canvas: the article is the root, branch topics are nodes with their summaries, and summaries are intermediate nodes leading to leaf cards showing the original source sentences. The view starts with the top-level topics visible. Clicking a topic unfolds or folds it (optionally one branch at a time), and its sentence count unfolds the whole branch. The view controls (one branch at a time, level switcher, Fit) sit in the page bar beside the title to leave the canvas more room. Leaf cards can be moved and resized. A **Chat** tab on each card unfolds a chat about that source text, which can also read and search the rest of the article ([`SourceCardChatDrawer`](../src/topics-tree/SourceCardChatDrawer.jsx)). **Show in page** on a card opens the topics rail at that topic's sentences, as the hierarchy view does.

Like the [hierarchy](09-hierarchy.md), the topics tree is **aggregated**: it is built on [`buildTopicTree`](../src/domain/topicTree.js), so each unique topic path is one node, unlike the chronological [canvas](08-canvas.md) cards. Branch title sizes grow with the share of the article's sentences the topic covers. Zooming out counter-scales topic and source-card titles and gently widens their containers so grown titles stay readable without awkward word breaks.

When a parent has only one child and both share the same summary, the child shows **Same summary as parent · Show summary** in place of that prose. Readers can reveal and hide the copy locally without changing the branch's expansion. The first copy and distinct summaries stay visible. Additional source text or sibling topics make the branch ineligible for this treatment.

Node sizes are measured from the DOM and placed by a contour-based tidy layout in [`treeLayout.js`](../src/topics-tree/treeLayout.js), so the layout follows the rendered text. Pure functions build the nodes in [`displayTree.js`](../src/topics-tree/displayTree.js) and apply expand and collapse rules in [`expansion.js`](../src/topics-tree/expansion.js).

The **Topics** switcher in the header offers **Pipeline**, **Summary tree**, and **Questions**. The [summary tree](15-summary-tree.md) uses its saved structure, with an article overview at the root and passage summaries that lead to source sentence leaf cards. The [questions view](17-questions.md) uses the aggregated layout for question groups, questions with answers, and supporting points. Source cards show the cited sentences, and **Show in page** opens the rail at those sentences.

Questions already generated in Canvas, Hierarchy, or Topics Tree are loaded from the same saved record. If none have been saved, **Find questions** starts a build. While it runs, the header shows progress and **Stop** in place of the tree controls. **Resume** continues an interrupted build, and **Rebuild** starts over.

The view opens in the same record iframe as the canvas, with `view=tree` selecting the topics tree app. It is opened from the popup's **Tree** button.

Entrypoint: [`src/canvas/main.jsx`](../src/canvas/main.jsx) (which selects and renders [`TopicsTreeApp`](../src/topics-tree/TopicsTreeApp.jsx) for the tree route)
