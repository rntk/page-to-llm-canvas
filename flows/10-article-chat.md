# Article chat

Article chat is available from the canvas, topic hierarchy, and rails for a saved page or transcript. A turn combines the user’s question, bounded article sentences, and recent chat history. Previously painted chat evidence prevents overlapping highlight requests. Large source text is chunked for parallel LLM requests; replies from multiple chunks are synthesized into the answer.

The assistant can emit a highlight tool event that points to one-based source sentence lines. Those events are stored with the chat, rendered as evidence, and routed back to the active page, canvas, or YouTube rail for highlighting or seeking. Turns can be cancelled and chat sessions can be revisited or deleted.

Use **Choose topics** to search and select one or more topics. The chat displays its scope and sends only those topics’ sentences (including descendants and recurring passages), retaining their original document line numbers. Separate passages share a request when they fit the context budget; highlights cannot span omitted sentences. Changing scope starts a new conversation so previous whole-document history is not sent into a scoped chat. Clear the selection to return to the whole document. Saved chats retain their scope. If a selected topic no longer exists after topics change, the history remains readable, but sending is blocked until you choose a new scope and start a new chat. Topic card menus offer **To chat** to open a fresh conversation scoped to that topic.

The [project canvas](16-project-canvas.md#per-page-chat) opens the same chat beside each tab card. A saved page shares its history with that page's other chat surfaces, and an unsaved page chats over its live tab text under a URL-scoped history.

The [project canvas](16-project-canvas.md) also runs this chat as a project chat in its side panel, over the project's merged topic tree. No article sentences are sent: the model gets an overview of the included and skipped pages and answers through topic search, read and claim-source tools. It cites evidence in prose as an article title and its sentence numbers, without highlight tool events or topic scope. Its history is stored under a project-scoped key.

Entrypoint: [`src/chat/ArticleChat.jsx`](../src/chat/ArticleChat.jsx)
