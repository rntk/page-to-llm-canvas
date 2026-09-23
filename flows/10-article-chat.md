# Article chat

Article chat is available from the canvas and rails for a saved page or transcript. A turn combines the user’s question, bounded article sentences, and recent chat history. Previously painted chat evidence prevents overlapping highlight requests. Large source text is chunked for parallel LLM requests; replies from multiple chunks are synthesized into the answer.

The assistant can emit a highlight tool event that points to one-based source sentence lines. Those events are stored with the chat, rendered as evidence, and routed back to the active page, canvas, or YouTube rail for highlighting or seeking. Turns can be cancelled and chat sessions can be revisited or deleted.

Entrypoint: [`src/chat/ArticleChat.jsx`](../src/chat/ArticleChat.jsx)
