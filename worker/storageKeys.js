// Realm-neutral key helpers shared by the record and chat repositories. Keep
// this module dependency-free so repository dependency direction stays acyclic.

export function recordMetaStorageKey(key) {
  return `pagetollm:rec:${key}:meta`;
}

export function recordContentStorageKey(key) {
  return `pagetollm:rec:${key}:content`;
}

export function recordSummariesStorageKey(key) {
  return `pagetollm:rec:${key}:summaries`;
}

export function chatIndexStorageKey(key) {
  return `pagetollm:chats:${key}:index`;
}

export function chatDocumentStorageKey(key, chatId) {
  return `pagetollm:chats:${key}:${chatId}`;
}
