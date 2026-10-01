import { MSG } from '../shared/runtime/messages.js';
import { sendRuntimeMessage } from '../utils/runtimeMessages.js';

async function request(message) {
  const response = await sendRuntimeMessage(message);
  if (!response?.ok) throw new Error(response?.error || 'Chat storage request failed');
  return response;
}

/**
 * Read the active provider's chat budgets before splitting an article.
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
 * Append one turn; return `{stale: true}` if the source revision changed.
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
 * Stable production adapter for ArticleChat's repository port.
 *
 * @type {{list: Function, get: Function, append: Function, remove: Function}}
 */
export const browserChatRepository = Object.freeze({
  list: listStoredChats,
  get: getStoredChat,
  append: persistChatTurn,
  remove: removeStoredChat,
});
