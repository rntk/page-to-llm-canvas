import { MSG } from '../../messages.js';
import { sendRuntimeMessage } from '../utils/runtimeMessages.js';

async function request(message) {
  const response = await sendRuntimeMessage(message);
  if (!response?.ok) throw new Error(response?.error || 'Chat storage request failed');
  return response;
}

export async function listStoredChats(key) {
  return (await request({ type: MSG.listChats, key })).chats || [];
}

export async function getStoredChat(key, chatId) {
  return (await request({ type: MSG.getChat, key, chatId })).chat;
}

export async function persistChatTurn(key, chatId, turn) {
  const response = await request({ type: MSG.appendChatTurn, key, chatId, turn });
  return { chat: response.chat, messages: response.messages, events: response.events };
}

export async function removeStoredChat(key, chatId) {
  await request({ type: MSG.deleteChat, key, chatId });
}
