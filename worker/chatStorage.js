// Per-article chat persistence. Split out of storage.js so the record and chat
// aggregates stay separate concerns. It depends only on storage primitives and
// realm-neutral key helpers; storage.js owns the one-way cascade dependency.
import {
  getLocal,
  setLocal,
  removeLocal,
  queuedUpdate,
  MUTATION_QUEUE_KEY,
} from './storagePrimitives.js';
import {
  recordMetaStorageKey,
  chatIndexStorageKey,
  chatDocumentStorageKey,
} from './storageKeys.js';

const CHAT_TITLE_MAX_CHARS = 60;
export const MAX_CHAT_TURNS = 50;
const MAX_TURN_MESSAGES = 40;
// A model may emit several tool calls per round and the turn engine permits up
// to 50 rounds. Keep a finite abuse guard without rejecting a valid bounded
// engine result near the end of a long evidence-gathering turn.
const MAX_TURN_EVENTS = 200;
const MAX_LEGACY_MESSAGES = 400;
const MAX_LEGACY_EVENTS = 200;
const MAX_TURN_INDEX_ENTRIES = 200;

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
  return value && Array.isArray(value.chats)
    ? { ...value, turns: Array.isArray(value.turns) ? value.turns : [] }
    : { chats: [], turns: [] };
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
    contentRevision: chat.contentRevision,
  };
}

async function updateChatAndIndex(key, chat, currentIndex) {
  const index = currentIndex || (await readChatIndex(key));
  const summary = chatSummary(chat);
  index.chats = [summary, ...index.chats.filter((item) => item.chatId !== chat.chatId)].sort(
    (a, b) => b.updatedAt - a.updatedAt,
  );
  await setLocal({
    [chatDocumentStorageKey(key, chat.chatId)]: chat,
    [chatIndexStorageKey(key)]: index,
  });
  return chat;
}

/** A fresh empty chat. `titleIsDefault` marks the placeholder title as still
 * derivable from the first visible user message (see deriveChatTitle). */
function newChat(contentRevision) {
  const now = Date.now();
  return {
    chatId: createStorageId('chat'),
    title: 'New chat',
    titleIsDefault: true,
    createdAt: now,
    updatedAt: now,
    contentRevision,
    messages: [],
    events: [],
    turnIds: [],
    nextEventSeq: 1,
  };
}

function normalizeChatMessage(message, now, turnId) {
  return {
    id: createStorageId('message'),
    role: ['user', 'assistant', 'tool'].includes(message?.role) ? message.role : 'user',
    content: typeof message?.content === 'string' ? message.content : '',
    createdAt: now,
    turnId,
    ...(message?.hidden ? { hidden: true } : {}),
    ...(typeof message?.toolCallId === 'string' ? { toolCallId: message.toolCallId } : {}),
    ...(Array.isArray(message?.toolCalls) ? { toolCalls: message.toolCalls } : {}),
  };
}

function normalizeChatEvent(event, seq, now, turnId) {
  return {
    seq,
    eventType: typeof event?.eventType === 'string' ? event.eventType : 'highlight_span',
    data: event?.data && typeof event.data === 'object' ? event.data : {},
    createdAt: now,
    turnId,
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

async function readRecordContentRevision(key) {
  if (!key) return null;
  const metaKey = recordMetaStorageKey(key);
  const meta = (await getLocal(metaKey))[metaKey];
  if (!meta) return null;
  return typeof meta.contentRevision === 'string' && meta.contentRevision
    ? meta.contentRevision
    : 'legacy';
}

function normalizedChatRevision(chat) {
  return typeof chat?.contentRevision === 'string' && chat.contentRevision
    ? chat.contentRevision
    : 'legacy';
}

function isCompatible(chat, contentRevision) {
  return !!chat && normalizedChatRevision(chat) === contentRevision;
}

async function readStoredChat(key, chatId) {
  const storageKey = chatDocumentStorageKey(key, chatId);
  return (await getLocal(storageKey))[storageKey] || null;
}

export async function listChats(key) {
  const contentRevision = await readRecordContentRevision(key);
  if (!contentRevision) return [];
  return (await readChatIndex(key)).chats.filter(
    (chat) => normalizedChatRevision(chat) === contentRevision,
  );
}

export async function readChat(key, chatId) {
  if (!key || !chatId) return null;
  const [chat, contentRevision] = await Promise.all([
    readStoredChat(key, chatId),
    readRecordContentRevision(key),
  ]);
  return isCompatible(chat, contentRevision) ? chat : null;
}

function applyRetention(chat) {
  let messages = Array.isArray(chat.messages) ? chat.messages : [];
  let events = Array.isArray(chat.events) ? chat.events : [];
  const legacyTurnId = `legacy_${chat.chatId}`;
  if (messages.some((item) => !item.turnId) || events.some((item) => !item.turnId)) {
    const legacyMessages = messages
      .filter((item) => !item.turnId)
      .slice(-MAX_LEGACY_MESSAGES)
      .map((item) => ({ ...item, turnId: legacyTurnId }));
    const legacyEvents = events
      .filter((item) => !item.turnId)
      .slice(-MAX_LEGACY_EVENTS)
      .map((item) => ({ ...item, turnId: legacyTurnId }));
    messages = [...legacyMessages, ...messages.filter((item) => item.turnId)];
    events = [...legacyEvents, ...events.filter((item) => item.turnId)];
  }
  const turnIds = Array.isArray(chat.turnIds) ? chat.turnIds : [];
  if (
    (messages.some((item) => item.turnId === legacyTurnId) ||
      events.some((item) => item.turnId === legacyTurnId)) &&
    !turnIds.includes(legacyTurnId)
  ) {
    turnIds.unshift(legacyTurnId);
  }
  const keptTurnIds = turnIds.slice(-MAX_CHAT_TURNS);
  const kept = new Set(keptTurnIds);
  chat.turnIds = keptTurnIds;
  chat.messages = messages.filter((item) => kept.has(item.turnId));
  chat.events = events.filter((item) => kept.has(item.turnId));
}

function duplicateResult(chat, turnId) {
  return {
    chat,
    messages: chat.messages.filter((message) => message.turnId === turnId),
    events: chat.events.filter((event) => event.turnId === turnId),
    duplicate: true,
  };
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
 * @param {{turnId?: string, messages?: object[], events?: object[]}} turn
 * @returns {Promise<{chat: object, messages: object[], events: object[], duplicate: boolean}>}
 */
export async function appendChatTurn(key, chatId, turn = {}) {
  const inputMessages = Array.isArray(turn?.messages) ? turn.messages : [];
  const inputEvents = Array.isArray(turn?.events) ? turn.events : [];
  if (inputMessages.length === 0 && inputEvents.length === 0) {
    throw new Error('appendChatTurn: turn must include at least one message or event');
  }
  if (inputMessages.length > MAX_TURN_MESSAGES || inputEvents.length > MAX_TURN_EVENTS) {
    throw new Error('appendChatTurn: turn exceeds persistence limits');
  }
  return queuedChatUpdate(key, async () => {
    const contentRevision = await readRecordContentRevision(key);
    if (!contentRevision) throw new Error('record not found');
    const turnId =
      typeof turn.turnId === 'string' && turn.turnId.trim()
        ? turn.turnId.trim()
        : createStorageId('turn');
    const index = await readChatIndex(key);

    // The index-level mapping reconciles a retry of a first turn whose storage
    // commit succeeded but runtime response was lost (the client has no chatId).
    const mapped = index.turns.find((item) => item.turnId === turnId);
    if (mapped && chatId && mapped.chatId !== chatId) {
      throw new Error('turn already belongs to another chat');
    }
    if (mapped && (!chatId || mapped.chatId === chatId)) {
      const prior = await readStoredChat(key, mapped.chatId);
      if (isCompatible(prior, contentRevision)) return duplicateResult(prior, turnId);
    }

    let chat;
    if (chatId) {
      const stored = await readStoredChat(key, chatId);
      if (!isCompatible(stored, contentRevision)) throw new Error('chat not found');
      if (
        stored.messages?.some((message) => message.turnId === turnId) ||
        stored.events?.some((event) => event.turnId === turnId)
      ) {
        return duplicateResult(stored, turnId);
      }
      // Shallow copy so a failed write leaves no trace of the turn: every
      // mutation below reassigns properties/arrays, never touching `stored`.
      chat = { ...stored };
    } else {
      chat = newChat(contentRevision);
    }

    const now = Date.now();
    const messages = inputMessages.map((message) => normalizeChatMessage(message, now, turnId));
    const maxStoredSeq = (Array.isArray(chat.events) ? chat.events : []).reduce(
      (max, event) => (Number.isInteger(event?.seq) ? Math.max(max, event.seq) : max),
      0,
    );
    let seq = Math.max(
      Number.isInteger(chat.nextEventSeq) ? chat.nextEventSeq : 1,
      maxStoredSeq + 1,
    );
    const events = inputEvents.map((event) => normalizeChatEvent(event, seq++, now, turnId));

    chat.messages = [...(Array.isArray(chat.messages) ? chat.messages : []), ...messages];
    chat.events = [...(Array.isArray(chat.events) ? chat.events : []), ...events];
    chat.turnIds = [...(Array.isArray(chat.turnIds) ? chat.turnIds : []), turnId];
    applyRetention(chat);
    if (events.length) chat.nextEventSeq = seq;
    chat.updatedAt = now;
    deriveChatTitle(
      chat,
      messages.find((message) => message.role === 'user' && !message.hidden),
    );

    index.turns = [
      ...index.turns.filter((item) => item.turnId !== turnId),
      { turnId, chatId: chat.chatId },
    ].slice(-MAX_TURN_INDEX_ENTRIES);
    await updateChatAndIndex(key, chat, index);
    return { chat, messages, events, duplicate: false };
  });
}

export async function deleteChatEvent(key, chatId, seq) {
  return queuedChatUpdate(key, async () => {
    const chat = await readChat(key, chatId);
    if (!chat) throw new Error('chat not found');
    const nextEvents = chat.events.filter((event) => event.seq !== seq);
    if (nextEvents.length === chat.events.length) return null;
    chat.events = nextEvents;
    chat.updatedAt = Date.now();
    await updateChatAndIndex(key, chat);
    return chat;
  });
}

export async function deleteChatHistory(key, chatId) {
  return queuedChatUpdate(key, async () => {
    const index = await readChatIndex(key);
    const existed = index.chats.some((chat) => chat.chatId === chatId);
    if (!existed) return false;
    index.chats = index.chats.filter((chat) => chat.chatId !== chatId);
    index.turns = index.turns.filter((turn) => turn.chatId !== chatId);
    await writeChatIndex(key, index);
    await removeLocal(chatDocumentStorageKey(key, chatId));
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
  return [
    chatIndexStorageKey(key),
    ...index.chats.map((chat) => chatDocumentStorageKey(key, chat.chatId)),
  ];
}
