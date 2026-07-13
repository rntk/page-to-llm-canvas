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

export async function createStoredChat(key) {
  return (await request({ type: MSG.createChat, key })).chat;
}

export async function persistChatMessage(key, chatId, message) {
  return (await request({ type: MSG.appendChatMessage, key, chatId, message })).message;
}

export async function persistChatEvent(key, chatId, event) {
  return (await request({ type: MSG.appendChatEvent, key, chatId, event })).event;
}

export async function removeStoredChatEvent(key, chatId, seq) {
  await request({ type: MSG.deleteChatEvent, key, chatId, seq });
}

export async function removeStoredChat(key, chatId) {
  await request({ type: MSG.deleteChat, key, chatId });
}
