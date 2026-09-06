import { MSG } from '../shared/runtime/messages.js';
import { sendRuntimeMessage } from '../utils/runtimeMessages.js';

async function request(message) {
  const response = await sendRuntimeMessage(message);
  if (!response?.ok) throw new Error(response?.error || 'Chat storage request failed');
  return response;
}

/**
 * Reads the active provider's safe article-chat source budget. The provider is
 * resolved in the background, where its context-window setting is available;
 * the content-script must know the limit before it can split an article.
 * @returns {Promise<{maxChunkChars: number, maxHistoryChars: number}>}
 */
export async function getArticleChatLimits() {
  const response = await request({ type: MSG.getArticleChatLimits });
  const maxChunkChars = Number(response.maxChunkChars);
  const maxHistoryChars = Number(response.maxHistoryChars);
  if (
    !Number.isFinite(maxChunkChars) ||
    maxChunkChars <= 0 ||
    !Number.isFinite(maxHistoryChars) ||
    maxHistoryChars < 0
  ) {
    throw new Error('The chat context limit is invalid. Check the active LLM provider settings.');
  }
  return { maxChunkChars: Math.floor(maxChunkChars), maxHistoryChars: Math.floor(maxHistoryChars) };
}

export async function listStoredChats(key) {
  return (await request({ type: MSG.listChats, key })).chats || [];
}

export async function getStoredChat(key, chatId) {
  return (await request({ type: MSG.getChat, key, chatId })).chat;
}

/**
 * Appends one turn. `expectedContentRevision` is the revision of the source
 * the turn was answered from; the background rejects the write when the record
 * has been reanalyzed since, which surfaces here as `{stale: true}` instead of
 * a chat.
 * @param {string} key Record key.
 * @param {string | null} chatId Existing chat, or falsy to create one inline.
 * @param {object} turn Whole turn: messages and/or events.
 * @param {object} [options]
 * @param {string} [options.expectedContentRevision]
 * @returns {Promise<{chat?: object, stale?: boolean}>}
 */
export async function persistChatTurn(key, chatId, turn, { expectedContentRevision } = {}) {
  const response = await request({
    type: MSG.appendChatTurn,
    key,
    chatId,
    turn,
    ...(typeof expectedContentRevision === 'string' && expectedContentRevision
      ? { contentRevision: expectedContentRevision }
      : {}),
  });
  return response.stale ? { stale: true } : { chat: response.chat };
}

export async function removeStoredChat(key, chatId) {
  await request({ type: MSG.deleteChat, key, chatId });
}

/**
 * Production adapter for the chat repository port consumed by
 * `useChatSessions` / `ArticleChat`. It is a single frozen module-scope object
 * so callers never build one inline per render — the hook's effects depend on
 * this identity (see useChatSessions.js), and a fresh object each render would
 * reload history in a loop.
 *
 * @type {{list: Function, get: Function, append: Function, remove: Function}}
 */
export const browserChatRepository = Object.freeze({
  list: listStoredChats,
  get: getStoredChat,
  append: persistChatTurn,
  remove: removeStoredChat,
});
