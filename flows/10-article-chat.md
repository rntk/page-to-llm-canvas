# Article chat

Article chat is available from the canvas, topic hierarchy, and rails for a saved page or transcript. A turn combines the user’s question, bounded article sentences, and recent chat history. Previously painted chat evidence prevents overlapping highlight requests. Large source text is chunked for parallel LLM requests; replies from multiple chunks are synthesized into the answer.

The assistant can emit a highlight tool event that points to one-based source sentence lines. Those events are stored with the chat, rendered as evidence, and routed back to the active page, canvas, or YouTube rail for highlighting or seeking. Turns can be cancelled and chat sessions can be revisited or deleted.

Use **Choose topics** to search and select one or more topics. The chat displays its scope and sends only those topics’ sentences (including descendants and recurring passages), retaining their original document line numbers. Separate passages share a request when they fit the context budget; highlights cannot span omitted sentences. Changing scope starts a new conversation so previous whole-document history is not sent into a scoped chat. Clear the selection to return to the whole document. Saved chats retain their scope. If a selected topic no longer exists after topics change, the history remains readable, but sending is blocked until you choose a new scope and start a new chat. Topic card menus offer **To chat** to open a fresh conversation scoped to that topic.

Entrypoint: [`src/chat/ArticleChat.jsx`](../src/chat/ArticleChat.jsx)
