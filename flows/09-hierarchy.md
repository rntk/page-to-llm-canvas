# Hierarchy

The hierarchy view presents the extracted topic paths as a collapsible tree. It derives the tree from the saved topic records, lets the user choose the visible depth, and shows the relevant summary and source evidence for a selected node.

The hierarchy is an **aggregated** view: each unique topic path appears as exactly one node, wherever its sentences fall in the source. This intentionally differs from the [canvas](08-canvas.md) and rails, which are **chronological**: they split each topic into contiguous sentence runs and order the cards by source position. A topic whose sentences are spread across the article therefore appears once here but can appear as several cards on the canvas. The hierarchy tree is built by [`buildTopicTree`](../src/domain/topicTree.js), and the canvas and rails use [`buildTopicHierarchyTree`](../src/domain/topicDomain.js). The two builders are kept separate on purpose.

For YouTube records, hierarchy evidence can include links or controls that jump to the corresponding video timestamp. The view is opened as the same record iframe as the canvas, with a route selecting the hierarchy app.

Entrypoint: [`src/canvas/main.jsx`](../src/canvas/main.jsx) (which selects and renders [`HierarchyApp`](../src/hierarchy/HierarchyApp.jsx) for the hierarchy route)
