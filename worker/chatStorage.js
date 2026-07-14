// Per-article chat persistence. Split out of storage.js so the record and chat
// aggregates stay separate concerns. Shares the low-level primitives (getLocal/
// setLocal/removeLocal, queuedUpdate, MUTATION_QUEUE_KEY) with storage.js via
// storagePrimitives.js, and reaches into storage.js only through the small
// recordExists() gate. storage.js in turn imports deleteChatsForRecord from
// here for its cascade-delete — one sanctioned runtime cycle, both crossings
// used only inside function bodies.
import {
  getLocal,
  setLocal,
  removeLocal,
  queuedUpdate,
  MUTATION_QUEUE_KEY,
} from './storagePrimitives.js';
import { recordExists } from './storage.js';

const CHAT_TITLE_MAX_CHARS = 60;

function chatIndexStorageKey(key) {
  return `pagetollm:chats:${key}:index`;
}

function chatStorageKey(key, chatId) {
  return `pagetollm:chats:${key}:${chatId}`;
}

// Every chat mutation serializes on the same global mutation queue as the
// record writes, so a chat write and a cascade-delete of the same record can
// never interleave. The queue already serializes every caller, so no per-key
// sub-queue is needed.
function queuedChatUpdate(key, fn) {
  return queuedUpdate(MUTATION_QUEUE_KEY, fn);
}

function createStorageId(prefix) {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `${prefix}_${uuid}`;
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

async function readChatIndex(key) {
  const storageKey = chatIndexStorageKey(key);
  const value = (await getLocal(storageKey))[storageKey];
  return value && Array.isArray(value.chats) ? value : { chats: [] };
}

async function writeChatIndex(key, index) {
  await setLocal({ [chatIndexStorageKey(key)]: index });
}

function chatSummary(chat) {
  return {
    chatId: chat.chatId,
    title: chat.title,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    messageCount: chat.messages.filter((message) => !message.hidden).length,
    eventCount: chat.events.length,
  };
}

async function updateChatAndIndex(key, chat) {
  const index = await readChatIndex(key);
  const summary = chatSummary(chat);
  index.chats = [summary, ...index.chats.filter((item) => item.chatId !== chat.chatId)].sort(
    (a, b) => b.updatedAt - a.updatedAt,
  );
  await setLocal({
    [chatStorageKey(key, chat.chatId)]: chat,
    [chatIndexStorageKey(key)]: index,
  });
  return chat;
}

/** A fresh empty chat. `titleIsDefault` marks the placeholder title as still
 * derivable from the first visible user message (see deriveChatTitle). */
function newChat() {
  const now = Date.now();
  return {
    chatId: createStorageId('chat'),
    title: 'New chat',
    titleIsDefault: true,
    createdAt: now,
    updatedAt: now,
    messages: [],
    events: [],
    nextEventSeq: 1,
  };
}

function normalizeChatMessage(message, now) {
  return {
    id: createStorageId('message'),
    role: ['user', 'assistant', 'tool'].includes(message?.role) ? message.role : 'user',
    content: typeof message?.content === 'string' ? message.content : '',
    createdAt: now,
    ...(message?.hidden ? { hidden: true } : {}),
    ...(typeof message?.reasoning === 'string' ? { reasoning: message.reasoning } : {}),
    ...(typeof message?.toolCallId === 'string' ? { toolCallId: message.toolCallId } : {}),
    ...(Array.isArray(message?.toolCalls) ? { toolCalls: message.toolCalls } : {}),
  };
}

function normalizeChatEvent(event, seq, now) {
  return {
    seq,
    eventType: typeof event?.eventType === 'string' ? event.eventType : 'highlight_span',
    data: event?.data && typeof event.data === 'object' ? event.data : {},
    createdAt: now,
  };
}

/**
 * True while the chat still carries the placeholder title, so it should be
 * derived from the first visible user message. `titleIsDefault` is the flag;
 * the `title === 'New chat'` fallback keeps chats stored before the flag
 * existed deriving correctly.
 */
function titleIsDerivable(chat) {
  if (chat.titleIsDefault === true) return true;
  return chat.titleIsDefault === undefined && chat.title === 'New chat';
}

/**
 * Derives the chat title from a normalized user message in place, when the
 * title is still the derivable placeholder. A blank message leaves the
 * placeholder untouched so a later message can still set it.
 */
function deriveChatTitle(chat, message) {
  if (!titleIsDerivable(chat)) return;
  if (!message || message.role !== 'user' || message.hidden) return;
  const derived = message.content.trim().slice(0, CHAT_TITLE_MAX_CHARS);
  if (derived) {
    chat.title = derived;
    chat.titleIsDefault = false;
  }
}

export async function listChats(key) {
  return (await readChatIndex(key)).chats;
}

export async function readChat(key, chatId) {
  if (!key || !chatId) return null;
  const storageKey = chatStorageKey(key, chatId);
  return (await getLocal(storageKey))[storageKey] || null;
}

/**
 * Persists one whole LLM turn — any mix of messages and events — as a single
 * queued mutation and a single storage write, so a mid-turn failure can never
 * leave a dangling assistant tool-call message that corrupts replayed history.
 *
 * When `chatId` is falsy the chat is created inline (the record must exist)
 * so a failed first turn leaves no empty orphan chat. Messages/events are
 * normalized the same way regardless of chatId, event seqs continue from the
 * chat's nextEventSeq, and the title is derived from the first visible user
 * message in the batch.
 *
 * @param {string} key
 * @param {string | null | undefined} chatId
 * @param {{messages?: object[], events?: object[]}} turn
 * @returns {Promise<{chat: object, messages: object[], events: object[]}>}
 */
export async function appendChatTurn(key, chatId, turn = {}) {
  const inputMessages = Array.isArray(turn?.messages) ? turn.messages : [];
  const inputEvents = Array.isArray(turn?.events) ? turn.events : [];
  if (inputMessages.length === 0 && inputEvents.length === 0) {
    throw new Error('appendChatTurn: turn must include at least one message or event');
  }
  return queuedChatUpdate(key, async () => {
    let chat;
    if (chatId) {
      const stored = await readChat(key, chatId);
      if (!stored) throw new Error('chat not found');
      // Shallow copy so a failed write leaves no trace of the turn: every
      // mutation below reassigns properties/arrays, never touching `stored`.
      chat = { ...stored };
    } else {
      if (!(await recordExists(key))) throw new Error('record not found');
      chat = newChat();
    }

    const now = Date.now();
    const messages = inputMessages.map((message) => normalizeChatMessage(message, now));
    let seq = Number.isInteger(chat.nextEventSeq) ? chat.nextEventSeq : 1;
    const events = inputEvents.map((event) => normalizeChatEvent(event, seq++, now));

    chat.messages = [...chat.messages, ...messages];
    chat.events = [...chat.events, ...events];
    if (events.length) chat.nextEventSeq = seq;
    chat.updatedAt = now;
    deriveChatTitle(
      chat,
      messages.find((message) => message.role === 'user' && !message.hidden),
    );

    await updateChatAndIndex(key, chat);
    return { chat, messages, events };
  });
}

export async function deleteChatEvent(key, chatId, seq) {
  return queuedChatUpdate(key, async () => {
    const chat = await readChat(key, chatId);
    if (!chat) throw new Error('chat not found');
    const nextEvents = chat.events.filter((event) => event.seq !== seq);
    if (nextEvents.length === chat.events.length) return false;
    chat.events = nextEvents;
    chat.updatedAt = Date.now();
    await updateChatAndIndex(key, chat);
    return true;
  });
}

export async function deleteChatHistory(key, chatId) {
  return queuedChatUpdate(key, async () => {
    const index = await readChatIndex(key);
    const existed = index.chats.some((chat) => chat.chatId === chatId);
    if (!existed) return false;
    index.chats = index.chats.filter((chat) => chat.chatId !== chatId);
    await writeChatIndex(key, index);
    await removeLocal(chatStorageKey(key, chatId));
    return true;
  });
}

/**
 * Every storage key holding chat documents for a record: the chat index plus
 * one key per chat. Reading these before any removal lets deleteAll gather all
 * chat keys up front, so a read failure aborts the cascade with nothing deleted.
 */
export async function chatStorageKeysForRecord(key) {
  const index = await readChatIndex(key);
  return [chatIndexStorageKey(key), ...index.chats.map((chat) => chatStorageKey(key, chat.chatId))];
}

/**
 * Removes every chat document for a record. Deliberately unqueued: it is only
 * ever called from storage.js's deleteRecord/deleteAll, which already hold the
 * global mutation queue, so wrapping it in queuedChatUpdate would self-deadlock.
 */
export async function deleteChatsForRecord(key) {
  await removeLocal(await chatStorageKeysForRecord(key));
}
