# Project canvas

A project is a persistent identity for a browser tab group. A user turns an existing group into a project, and the project then opens as a pannable, zoomable canvas with one card per tab in that group.

Choosing **Open group project** on a page that is not in a group first creates a browser tab group containing that page, then creates the project and opens its project page inside the same group. If the page already belongs to a group, the action opens that group's existing project or creates one when needed. The keyboard shortcut follows the same behavior for the active tab.

Browser tab group ids do not survive a restart, so the project is anchored by a dedicated project page tab that lives inside its group. The worker uses that tab to rebind the project to its live group. Opening a project focuses this page tab, or recreates it inside the group if it is missing.

The project page is its own extension page. It shares pan and zoom behavior with the [record canvas](08-canvas.md). The options page lists projects and their open state, and a [project chat](#project-chat) panel beside the canvas answers questions across the project's merged topics.

## Project actions

A **Canvas / Topics tree** tab bar in the header switches between the tab cards and the merged topics. The header's **Project actions** menu (a ☰ button) holds actions over the whole project. Each action is a descriptor with its own label, explanation, availability and handler, so more project-wide operations can be added without changing the menu.

**Merge similar topics** groups the saved primary topics of the project's pages into a single tree. It uses completed saved records whose URLs match tabs in the group, ignoring fragments and counting duplicate pages once. Unsaved pages, pages still processing and pages without usable primary topics are listed as skipped with the reason. Excerpts and live unsaved text do not become topic inputs. The merge view lists eligible pages and, for a saved result, the articles actually used in that snapshot.

The merge starts from the pages' primary topics and their existing cited summaries. Topics without reusable summaries get bounded passages confined to that primary topic. Similar topic inputs are then grouped across articles, and each level is summarized from the level below using the [summary tree](15-summary-tree.md) pipeline. The merge is saved on the project and leaves every source record's topics and summaries intact.

The result uses the same progressive tree, levels, one-branch option, pan/zoom and movable source cards as an article's summary tree. A branch may combine several articles; its sentence and article counts describe that coverage. Unfolding it reaches the original text, grouped by article with the article's title, full URL, source link and original sentence numbers. Global row ids used internally by the merged tree are mapped back to each source record's local line numbers, so two articles' line 1 can never be confused.

**Adding pages later.** The merged tree is saved on the project and survives extension reloads. When pages are added, edited or removed, the view lists how many (new / updated / removed) and offers **Add changes** (also what **Merge similar topics** does for a stale tree). This is incremental: pages are compared by content, not tab order or title; removed or edited pages leave the tree and empty branches are pruned; each new page’s topics are summarized, then descend from the root into the existing branch they fit best (or join the level where none fits). Only the branches on those paths are re-summarized, and every other branch and its original-text citations are kept. New rows are appended after the existing ones, so earlier citations never shift. If an addition is interrupted, the saved tree already holds the unplaced pages and resume finishes only them. **Rebuild** regroups everything, and a different provider also regroups, because the saved structure came from another model. The incremental path needs a finished tree with a root; a merge interrupted before grouping restarts from its passages.

**Stop**, **Resume** and **Rebuild** control the background merge. Completed work is checkpointed; resume reuses it while sources and provider identity match. A stopped worker becomes interrupted after a minute without a save and can be resumed. A saved result remains readable when the project's membership or primary topics change, with a notice to rebuild it from the current sources. Switching back to the **Canvas** tab keeps tab positions and open page/excerpt chats. Opening the **Topics tree** tab only shows the saved result; **Merge similar topics** from the menu (or the chat panel) also starts a build when none exists.

## Project chat

The chat panel beside the canvas (**Hide** collapses it) talks to the project as a whole. In v1 it works only over the project's merged topic tree: the merged summaries and the original sentences under them. It does not read live or unsaved pages, excerpts, or raw page text.

The model has four tools over that tree: `get_topic` (a topic's summary and children), `read_topic_content` (the original sentences under a topic, grouped by article), `search_topics` (find topics by words) and `get_claim_sources` (the sources behind a summary claim). Answers cite in prose, naming the article and its local sentence numbers, never the merged tree's internal global row ids.

Chat needs a completed merge and never starts one itself. The panel asks the worker for the chat tree (`getProjectChatTree`, built on the same view as the merge) when it opens and again whenever the merge's status or revision changes:

- **No merge yet, or an incomplete one** (running, interrupted, stopped, failed). The panel explains the state and offers a button that opens the merge view, where the merge can be started or resumed. Chat appears once the merge finishes.
- **Stale merge.** If pages or topics changed after the merge, the saved merge still answers, and a non-blocking notice above the chat says "Pages or topics changed since this merge. Answers use the saved merge — rebuild to include current pages." with a button to the merge view.
- **Skipped pages.** If some pages were skipped by the merge, the panel notes how many are not included.

Conversation history is stored under a project chat key, separate from page and excerpt chats, so it never mixes with any article's history.

## Per-page chat

Each tab card has a small **Chat** fold tab on its right edge. It unfolds that page's [article chat](10-article-chat.md) beside the card, inside the canvas, so the chat pans and zooms with its card. Several page chats can be open at once. Inside an open chat, the wheel scrolls messages and arrow keys stay in the chat; Ctrl/⌘+wheel still zooms the canvas.

A page chat only ever shows that page's history:

- **Saved page.** If the tab's URL matches a saved record (ignoring the `#fragment`), the chat uses that record's key, sentences and topics. It shares history with the chat opened on the page itself (rails, record canvas, hierarchy), so a conversation started in either place appears in both, and **Choose topics** scoping works as usual. A record whose text is still being processed shows a waiting note.
- **Unsaved page.** If no record matches, the chat runs over the whole page. Topic scoping is hidden because there are no topics. The page's text is read from the live tab through the content script on the first send of a drawer session, using the picker's Find detection and falling back to the page body. Nothing is submitted for processing. Chats are stored under a URL-derived page key (`page:<url without fragment>`), and storage reconciliation keeps them even though no record owns them.
- **Saved later.** When a record is later saved for that URL, listing its chats moves the page chats into the record, so the on-page chat sees them too. Their messages carry over, but their highlight events are dropped, because those line numbers referred to the live page text rather than the record's sentences.

Browser-internal pages (for example `chrome://`) cannot be read and say so. A tab that is discarded or still loading reports an error on send, and the next send tries the read again.

## Excerpts

An excerpt is a passage of a page that gets its own card and chat on the project canvas. Select text on any web page and choose **Open excerpt in project** from the context menu. The tab's project is opened the same way as **Open group project**: an ungrouped tab gets a group, and a group without a project gets one. The excerpt is saved to that project, and the project page opens with the excerpt's chat unfolded. The worker asks the content script for the selection so line breaks are kept. If the selection is in a subframe, or the page does not answer, it uses the menu's flattened copy of the selection instead. Excerpts are capped at 20,000 characters, and a longer selection is cut and marked.

- **Linked to its page.** An excerpt is matched to its page by URL, ignoring the `#fragment`, because tab ids do not survive a restart. Its card stacks under the matching tab card, and a dashed connector joins the two. The card header names the page, and clicking the name switches to that tab. An excerpt follows its page card when the card is dragged, until the excerpt is dragged on its own. If no tab in the group shows its page, the excerpt waits in a trailing slot with a dashed border, and its page name is disabled.
- **Local chat.** Each excerpt has a **Chat** fold like a tab card. Its history is stored under `excerpt:<id>`, so it never mixes with the page's own chat. A turn sends the excerpt's sentences as numbered lines, framed as an excerpt with the page's title and URL. The system prompt says that the text is part of a longer page. `highlight_span` cites excerpt lines.
- **Reading the rest of the page.** The excerpt chat also offers a `read_page` tool. It returns numbered page lines, starting a few lines before the place where the excerpt was found unless the model asks for a `start_line`. Each result also gives `nextStartLine`, so the model can keep reading. The text comes from the page's saved record when there is one, or else from the live tab. It is read once per drawer session. Tool results share the space left in the chunk's context budget, so repeated reads cannot overflow the provider's window. If the page is neither saved nor open, the tool reports an error, and the model answers from the excerpt alone.
- **Deleting.** **Delete** on the card removes the excerpt and its chats. Deleting a project from the options page also removes its excerpts.

Entry points:

- [Project domain](../src/core/projects/projects.js) — project identity and the rules for rebinding it to a group.
- [Project service](../src/extension/background/projects.js) — binds projects to groups and opens or focuses their pages.
- [Project page](../src/project/main.jsx) — the canvas that renders a project's tabs.
- [Project actions menu](../src/project/ProjectActionsMenu.jsx) and [merged topics view](../src/project/ProjectTopicTree.jsx) — project-wide actions and the attributed summary tree.
- [Project topic sources](../src/core/projects/projectTopicTree.js) and [project topic tree service](../src/extension/background/projectTopicTree.js) — primary-topic evidence, global-to-local source mapping and the background merge lifecycle.
- [Project chat panel](../src/project/ProjectChatPanel.jsx) and [project chat](../src/project/ProjectChat.jsx) — the panel's merge states and the chat over the merged tree.
- [Project chat tools](../src/core/projects/projectChatTools.js) — `get_topic`, `read_topic_content`, `search_topics` and `get_claim_sources`.
- [Page chat drawer](../src/project/PageChatDrawer.jsx) — the per-page chat beside a tab card.
- [Page chat service](../src/extension/background/projectPageChat.js) — resolves a tab to its record or page key and reads live tab text.
- [Excerpt domain and store](../src/core/projects/excerpts.js) — excerpt shape and the one-shot request to unfold an excerpt's chat.
- [Excerpt service](../src/extension/background/projectExcerpts.js) — the selection menu action, excerpt deletion, and reading an excerpt's page.
- [Excerpt card](../src/project/ExcerptCard.jsx) and [excerpt chat drawer](../src/project/ExcerptChatDrawer.jsx) — the card linked to its page, and its chat with the [`read_page` tool](../src/chat/readPageTool.js).
