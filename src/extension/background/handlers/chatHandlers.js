import { MSG } from '../../../shared/runtime/messages.js';

function isSafeChatId(chatId) {
  return typeof chatId === 'string' && !!chatId && !chatId.includes(':');
}

/**
 * Handlers for article chat: provider completions, turn cancellation, and the
 * persisted chat history.
 *
 * @param {object} deps
 * @param {{listChats: Function, readChat: Function, appendChatTurn: Function, deleteChatHistory: Function}} deps.chatRepository
 * @param {{complete: Function, cancelTurn: Function}} deps.chatService
 */
export function createChatHandlers({ chatRepository, chatService }) {
  const { listChats, readChat, appendChatTurn, deleteChatHistory } = chatRepository;

  return {
    [MSG.llmChatCompletion]: {
      requiresExtensionPage: false,
      validate: () => null,
      async handle(msg) {
        return chatService.complete(msg);
      },
    },

    [MSG.cancelChatTurn]: {
      requiresExtensionPage: false,
      validate(msg) {
        return typeof msg.turnId === 'string' && msg.turnId ? null : 'missing turnId';
      },
      async handle(msg) {
        chatService.cancelTurn(msg.turnId);
        return { ok: true };
      },
    },

    [MSG.listChats]: {
      requiresExtensionPage: false,
      validate(msg) {
        return msg.key ? null : 'missing key';
      },
      async handle(msg) {
        return { ok: true, chats: await listChats(msg.key) };
      },
    },

    [MSG.getChat]: {
      requiresExtensionPage: false,
      validate(msg) {
        if (!msg.key) return 'missing key';
        if (!msg.chatId) return 'missing chatId';
        return isSafeChatId(msg.chatId) ? null : 'invalid chatId';
      },
      async handle(msg) {
        const chat = await readChat(msg.key, msg.chatId);
        return chat ? { ok: true, chat } : { ok: false, error: 'chat not found' };
      },
    },

    // Persists a whole LLM turn (messages + events) as one atomic write; a falsy
    // chatId creates the chat inline so a failed first turn leaves no orphan chat.
    [MSG.appendChatTurn]: {
      requiresExtensionPage: false,
      validate(msg) {
        if (!msg.key) return 'missing key';
        if (msg.chatId && !isSafeChatId(msg.chatId)) return 'invalid chatId';
        if (!msg.turn || typeof msg.turn !== 'object') return 'missing turn';
        const hasMessages = Array.isArray(msg.turn.messages) && msg.turn.messages.length > 0;
        const hasEvents = Array.isArray(msg.turn.events) && msg.turn.events.length > 0;
        return hasMessages || hasEvents ? null : 'empty turn';
      },
      async handle(msg) {
        const { chat } = await appendChatTurn(msg.key, msg.chatId, msg.turn);
        return { ok: true, chat };
      },
    },

    [MSG.deleteChat]: {
      requiresExtensionPage: false,
      validate(msg) {
        if (!msg.key) return 'missing key';
        if (!msg.chatId) return 'missing chatId';
        return isSafeChatId(msg.chatId) ? null : 'invalid chatId';
      },
      async handle(msg) {
        await deleteChatHistory(msg.key, msg.chatId);
        return { ok: true };
      },
    },
  };
}
