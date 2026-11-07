# Project canvas

A project is a persistent identity for a browser tab group. A user turns an existing group into a project, and the project then opens as a pannable, zoomable canvas with one card per tab in that group.

Choosing **Open group project** on a page that is not in a group first creates a browser tab group containing that page, then creates the project and opens its project page inside the same group. If the page already belongs to a group, the action opens that group's existing project or creates one when needed. The keyboard shortcut follows the same behavior for the active tab.

Browser tab group ids do not survive a restart, so the project is anchored by a dedicated project page tab that lives inside its group. The worker uses that tab to rebind the project to its live group. Opening a project focuses this page tab, or recreates it inside the group if it is missing.

The project page is its own extension page. It shares pan and zoom behavior with the [record canvas](08-canvas.md). The options page lists projects and their open state, and a chat panel beside the canvas is reserved for conversation across the project's pages.

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
- [Page chat drawer](../src/project/PageChatDrawer.jsx) — the per-page chat beside a tab card.
- [Page chat service](../src/extension/background/projectPageChat.js) — resolves a tab to its record or page key and reads live tab text.
- [Excerpt domain and store](../src/core/projects/excerpts.js) — excerpt shape and the one-shot request to unfold an excerpt's chat.
- [Excerpt service](../src/extension/background/projectExcerpts.js) — the selection menu action, excerpt deletion, and reading an excerpt's page.
- [Excerpt card](../src/project/ExcerptCard.jsx) and [excerpt chat drawer](../src/project/ExcerptChatDrawer.jsx) — the card linked to its page, and its chat with the [`read_page` tool](../src/chat/readPageTool.js).
