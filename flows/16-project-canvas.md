# Project canvas

A project brings a browser tab group together in a persistent workspace. Its canvas provides a shared view of the group's pages, with space to explore each page and selected excerpts.

The canvas has two complementary views: the pages themselves and a combined topic tree built from saved article topics. The combined tree preserves links to source articles and sentences, so readers can move from shared themes back to their evidence. Project chat uses this tree to answer questions across the included articles. Page and excerpt chats remain scoped to their own content. They can highlight passages of it, and picking one of those events in the chat's Events tab unfolds a temporary evidence card under the drawer showing the cited lines; it is not saved and closes when another event is picked, the selection is cleared, or the chat is folded. In the combined tree, each source card also has a Chat tab: its chat is scoped to that text, and the assistant can read and search the full source article behind it. A topic's "Source text" block gathers the text of everything under it, grouped by sub-topic and article, and its chat can read and search every article it quotes.

Projects persist beyond a browser session and can be reopened from the project list. When their source pages change, the combined tree can be refreshed to reflect the current material; existing article records remain independent.

The [summary tree](15-summary-tree.md) describes the shared topic-tree approach. The main code entry points are the [project page](../src/project/main.jsx) and the [project topic tree](../src/project/ProjectTopicTree.jsx).

Topic merging runs as a project-owned background job. Readers can switch between Canvas and Topics, close the project view, or read source pages while it continues. Checkpoints and results are saved to the project, and running merges automatically resume after a background worker or browser restart. Reopening the project shows the saved progress or completed tree; Stop explicitly cancels processing.
