# Project canvas

A project is a persistent identity for a browser tab group. A user turns an existing group into a project, and the project then opens as a pannable, zoomable canvas with one card per tab in that group.

Browser tab group ids do not survive a restart, so the project is anchored by a dedicated project page tab that lives inside its group. The worker uses that tab to rebind the project to its live group. Opening a project focuses this page tab, or recreates it inside the group if it is missing.

The project page is its own extension page. It shares pan and zoom behavior with the [record canvas](08-canvas.md). The options page lists projects and their open state, and a chat panel beside the canvas is reserved for conversation across the project's pages.

## Per-page chat

Each tab card has a small **Chat** fold tab on its right edge. It unfolds that page's [article chat](10-article-chat.md) beside the card, inside the canvas, so the chat pans and zooms with its card. Several page chats can be open at once. Inside an open chat, the wheel scrolls messages and arrow keys stay in the chat; Ctrl/⌘+wheel still zooms the canvas.

A page chat only ever shows that page's history:

- **Saved page.** If the tab's URL matches a saved record (ignoring the `#fragment`), the chat uses that record's key, sentences and topics. It shares history with the chat opened on the page itself (rails, record canvas, hierarchy), so a conversation started in either place appears in both, and **Choose topics** scoping works as usual. A record whose text is still being processed shows a waiting note.
- **Unsaved page.** If no record matches, the chat runs over the whole page. Topic scoping is hidden because there are no topics. The page's text is read from the live tab through the content script on the first send of a drawer session, using the picker's Find detection and falling back to the page body. Nothing is submitted for processing. Chats are stored under a URL-derived page key (`page:<url without fragment>`), and storage reconciliation keeps them even though no record owns them.
- **Saved later.** When a record is later saved for that URL, listing its chats moves the page chats into the record, so the on-page chat sees them too. Their messages carry over, but their highlight events are dropped, because those line numbers referred to the live page text rather than the record's sentences.

Browser-internal pages (for example `chrome://`) cannot be read and say so. A tab that is discarded or still loading reports an error on send, and the next send tries the read again.

Entry points:

- [Project domain](../src/core/projects/projects.js) — project identity and the rules for rebinding it to a group.
- [Project service](../src/extension/background/projects.js) — binds projects to groups and opens or focuses their pages.
- [Project page](../src/project/main.jsx) — the canvas that renders a project's tabs.
- [Page chat drawer](../src/project/PageChatDrawer.jsx) — the per-page chat beside a tab card.
- [Page chat service](../src/extension/background/projectPageChat.js) — resolves a tab to its record or page key and reads live tab text.
