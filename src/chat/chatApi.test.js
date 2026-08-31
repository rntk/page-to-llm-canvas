import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendRuntimeMessage = vi.hoisted(() => vi.fn());
vi.mock('../utils/runtimeMessages.js', () => ({ sendRuntimeMessage }));

import {
  browserChatRepository,
  getArticleChatLimits,
  getStoredChat,
  listStoredChats,
  persistChatTurn,
  removeStoredChat,
} from './chatApi.js';

describe('chat API', () => {
  beforeEach(() => {
    sendRuntimeMessage.mockReset();
  });

  it('lists chats and normalizes a missing chat list to an empty array', async () => {
    sendRuntimeMessage.mockResolvedValueOnce({ ok: true, chats: [{ chatId: 'c1' }] });
    await expect(listStoredChats('article-1')).resolves.toEqual([{ chatId: 'c1' }]);
    expect(sendRuntimeMessage).toHaveBeenCalledWith({ type: 'listChats', key: 'article-1' });

    sendRuntimeMessage.mockResolvedValueOnce({ ok: true });
    await expect(listStoredChats('article-1')).resolves.toEqual([]);
  });

  it('reads and validates the article-chat limits from the runtime boundary', async () => {
    sendRuntimeMessage.mockResolvedValueOnce({
      ok: true,
      maxChunkChars: 1258.9,
      maxHistoryChars: 628.1,
    });
    await expect(getArticleChatLimits()).resolves.toEqual({
      maxChunkChars: 1258,
      maxHistoryChars: 628,
    });

    sendRuntimeMessage.mockResolvedValueOnce({ ok: true, maxChunkChars: 0, maxHistoryChars: 1 });
    await expect(getArticleChatLimits()).rejects.toThrow('chat context limit is invalid');
    sendRuntimeMessage.mockResolvedValueOnce({ ok: true, maxChunkChars: 1, maxHistoryChars: -1 });
    await expect(getArticleChatLimits()).rejects.toThrow('chat context limit is invalid');
  });

  it('gets, appends to, and removes a chat through the runtime boundary', async () => {
    sendRuntimeMessage.mockResolvedValueOnce({ ok: true, chat: { chatId: 'c1' } });
    await expect(getStoredChat('article-1', 'c1')).resolves.toEqual({ chatId: 'c1' });

    sendRuntimeMessage.mockResolvedValueOnce({ ok: true, chat: { chatId: 'c1', turns: 2 } });
    await expect(persistChatTurn('article-1', 'c1', { role: 'user' })).resolves.toEqual({
      chat: { chatId: 'c1', turns: 2 },
    });

    sendRuntimeMessage.mockResolvedValueOnce({ ok: true });
    await expect(removeStoredChat('article-1', 'c1')).resolves.toBeUndefined();
    expect(sendRuntimeMessage.mock.calls.map(([message]) => message)).toEqual([
      { type: 'getChat', key: 'article-1', chatId: 'c1' },
      { type: 'appendChatTurn', key: 'article-1', chatId: 'c1', turn: { role: 'user' } },
      { type: 'deleteChat', key: 'article-1', chatId: 'c1' },
    ]);
  });

  it('exposes a frozen repository adapter bound to the runtime-backed operations', () => {
    expect(browserChatRepository).toEqual({
      list: listStoredChats,
      get: getStoredChat,
      append: persistChatTurn,
      remove: removeStoredChat,
    });
    // Callers depend on this identity being stable across renders.
    expect(Object.isFrozen(browserChatRepository)).toBe(true);
  });

  it('rejects all operations when the background response is not successful', async () => {
    sendRuntimeMessage.mockResolvedValue({ ok: false, error: 'storage unavailable' });
    await expect(listStoredChats('article-1')).rejects.toThrow('storage unavailable');
    await expect(getStoredChat('article-1', 'c1')).rejects.toThrow('storage unavailable');
    await expect(persistChatTurn('article-1', 'c1', {})).rejects.toThrow('storage unavailable');
    await expect(removeStoredChat('article-1', 'c1')).rejects.toThrow('storage unavailable');
  });
});
