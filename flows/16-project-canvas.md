# Project canvas

A project brings a browser tab group together in a persistent workspace. Its canvas provides a shared view of the group's pages, with space to explore each page and selected excerpts.

The canvas has two complementary views: the pages themselves and a combined topic tree built from saved article topics. The combined tree preserves links to source articles and sentences, so readers can move from shared themes back to their evidence. Project chat uses this tree to answer questions across the included articles. Page and excerpt chats remain scoped to their own content. In the combined tree, each source card also has a Chat tab: its chat is scoped to that text, and the assistant can read and search the full source article behind it.

Projects persist beyond a browser session and can be reopened from the project list. When their source pages change, the combined tree can be refreshed to reflect the current material; existing article records remain independent.

The [summary tree](15-summary-tree.md) describes the shared topic-tree approach. The main code entry points are the [project page](../src/project/main.jsx) and the [project topic tree](../src/project/ProjectTopicTree.jsx).
