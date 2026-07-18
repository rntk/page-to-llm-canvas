// Per-article chat persistence. Split out of storage.js so the record and chat
// aggregates stay separate concerns. It depends only on storage primitives and
// realm-neutral key helpers; storage.js owns the one-way cascade dependency.
import {
  getLocal,
  getLocalByPrefix,
  setLocal,
  removeLocal,
  queuedUpdate,
  MUTATION_QUEUE_KEY,
} from './primitives.js';
import { recordMetaStorageKey, chatIndexStorageKey, chatDocumentStorageKey } from './keys.js';

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
const CHAT_STORAGE_PREFIX = 'pagetollm:chats:';
const CHAT_INDEX_SUFFIX = ':index';

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

function isSafeChatId(value) {
  return typeof value === 'string' && !!value && !value.includes(':');
}

function isStoredChatDocument(value) {
  return (
    !!value &&
    typeof value === 'object' &&
    isSafeChatId(value.chatId) &&
    Array.isArray(value.messages) &&
    Array.isArray(value.events)
  );
}

function recordKeyFromChatIndexStorageKey(storageKey) {
  if (!storageKey.startsWith(CHAT_STORAGE_PREFIX) || !storageKey.endsWith(CHAT_INDEX_SUFFIX)) {
    return null;
  }
  const key = storageKey.slice(CHAT_STORAGE_PREFIX.length, -CHAT_INDEX_SUFFIX.length);
  return key || null;
}

function recordKeyFromChatDocumentStorageEntry(storageKey, chat) {
  if (!isStoredChatDocument(chat) || !storageKey.startsWith(CHAT_STORAGE_PREFIX)) return null;
  const suffix = `:${chat.chatId}`;
  if (!storageKey.endsWith(suffix)) return null;
  const key = storageKey.slice(CHAT_STORAGE_PREFIX.length, -suffix.length);
  return key && chatDocumentStorageKey(key, chat.chatId) === storageKey ? key : null;
}

function chatTurnIds(chat) {
  const ids = [];
  const seen = new Set();
  const add = (turnId) => {
    if (typeof turnId !== 'string' || !turnId || seen.has(turnId)) return;
    seen.add(turnId);
    ids.push(turnId);
  };
  (Array.isArray(chat.turnIds) ? chat.turnIds : []).forEach(add);
  (Array.isArray(chat.messages) ? chat.messages : []).forEach((message) => add(message?.turnId));
  (Array.isArray(chat.events) ? chat.events : []).forEach((event) => add(event?.turnId));
  return ids.slice(-MAX_CHAT_TURNS);
}

function chatTurnMappings(chat) {
  const timestamps = new Map();
  for (const item of [...chat.messages, ...chat.events]) {
    if (typeof item?.turnId !== 'string' || !item.turnId) continue;
    const at = Number.isFinite(item.createdAt) ? item.createdAt : chat.updatedAt;
    timestamps.set(item.turnId, Math.max(timestamps.get(item.turnId) || 0, at || 0));
  }
  return chatTurnIds(chat).map((turnId, order) => ({
    turnId,
    chatId: chat.chatId,
    at: timestamps.get(turnId) || chat.updatedAt || chat.createdAt || 0,
    order,
  }));
}

function normalizedStoredIndex(value) {
  return value && Array.isArray(value.chats)
    ? { chats: value.chats, turns: Array.isArray(value.turns) ? value.turns : [] }
    : null;
}

function sameStoredValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
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
  if (!isSafeChatId(chatId)) return null;
  const storageKey = chatDocumentStorageKey(key, chatId);
  return (await getLocal(storageKey))[storageKey] || null;
}

export async function listChats(key) {
  const contentRevision = await readRecordContentRevision(key);
  if (!contentRevision) return [];
  return (await readChatIndex(key)).chats.filter(
    (chat) => isSafeChatId(chat?.chatId) && normalizedChatRevision(chat) === contentRevision,
  );
}

export async function readChat(key, chatId) {
  if (!key || !isSafeChatId(chatId)) return null;
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
  const turnIds = Array.isArray(chat.turnIds) ? [...chat.turnIds] : [];
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

    const retainedTurnIds = new Set(chat.turnIds);
    index.turns = [
      ...index.turns.filter(
        (item) =>
          item.turnId !== turnId &&
          (item.chatId !== chat.chatId || retainedTurnIds.has(item.turnId)),
      ),
      { turnId, chatId: chat.chatId },
    ].slice(-MAX_TURN_INDEX_ENTRIES);
    await updateChatAndIndex(key, chat, index);
    return { chat, messages, events, duplicate: false };
  });
}

export async function deleteChatHistory(key, chatId) {
  return queuedChatUpdate(key, async () => {
    const index = await readChatIndex(key);
    const nextChats = index.chats.filter((chat) => chat.chatId !== chatId);
    const nextTurns = index.turns.filter((turn) => turn.chatId !== chatId);

    // The document is the space-heavy object and must be removed before its
    // discoverability is dropped. If removal fails, the unchanged index keeps
    // the chat visible and retryable instead of stranding an orphan forever.
    // Chat ids are storage-key segments. Colons are never generated and would
    // make `{ key: 'a', chatId: 'b:chat_x' }` alias record `a:b`'s document.
    // Unsafe legacy/corrupt summaries can be dropped, but must never address a
    // physical document.
    if (isSafeChatId(chatId)) await removeLocal(chatDocumentStorageKey(key, chatId));

    if (nextChats.length === 0) {
      // No chat owns the retry mappings anymore; remove the empty aggregate
      // instead of leaving one small tombstone key per record.
      await removeLocal(chatIndexStorageKey(key));
    } else if (nextChats.length !== index.chats.length || nextTurns.length !== index.turns.length) {
      await writeChatIndex(key, { ...index, chats: nextChats, turns: nextTurns });
    }

    // Deletion is idempotent. A retry after a lost acknowledgement succeeds
    // even when both the document and its index entry were already absent.
    return true;
  });
}

/**
 * Removes chats grounded in superseded record content. Deliberately unqueued:
 * callers in storage.js already hold the global mutation queue while changing
 * the content revision, so queueing again here would self-deadlock.
 */
export async function pruneChatsForContentRevision(key, contentRevision) {
  const index = await readChatIndex(key);
  const allItems = await getLocalByPrefix(CHAT_STORAGE_PREFIX);
  const staleDocumentKeys = Object.entries(allItems)
    .filter(
      ([storageKey, chat]) =>
        recordKeyFromChatDocumentStorageEntry(storageKey, chat) === key &&
        !isCompatible(chat, contentRevision),
    )
    .map(([storageKey]) => storageKey);
  const staleChats = index.chats.filter((chat) => normalizedChatRevision(chat) !== contentRevision);
  if (staleChats.length === 0 && staleDocumentKeys.length === 0) {
    if (index.chats.length === 0) await removeLocal(chatIndexStorageKey(key));
    return 0;
  }

  const staleChatIds = new Set(staleChats.map((chat) => chat.chatId));
  const documentKeys = [
    ...new Set([
      ...staleChats
        .filter((chat) => isSafeChatId(chat?.chatId))
        .map((chat) => chatDocumentStorageKey(key, chat.chatId)),
      ...staleDocumentKeys,
    ]),
  ];
  if (documentKeys.length) await removeLocal(documentKeys);
  const chats = index.chats.filter((chat) => !staleChatIds.has(chat.chatId));
  if (chats.length === 0) {
    await removeLocal(chatIndexStorageKey(key));
  } else {
    await writeChatIndex(key, {
      ...index,
      chats,
      turns: index.turns.filter((turn) => !staleChatIds.has(turn.chatId)),
    });
  }
  return new Set([
    ...staleChatIds,
    ...staleDocumentKeys.map((storageKey) => allItems[storageKey]?.chatId).filter(Boolean),
  ]).size;
}

/**
 * Every storage key holding chat documents for a record: the chat index plus
 * one key per chat. Reading these before any removal lets deleteAll gather all
 * chat keys up front, so a read failure aborts the cascade with nothing deleted.
 */
export async function chatStorageKeysForRecord(key) {
  const index = await readChatIndex(key);
  const allItems = await getLocalByPrefix(CHAT_STORAGE_PREFIX);
  const discoveredDocuments = Object.entries(allItems)
    .filter(
      ([storageKey, value]) => recordKeyFromChatDocumentStorageEntry(storageKey, value) === key,
    )
    .map(([storageKey]) => storageKey);
  return [
    chatIndexStorageKey(key),
    ...index.chats
      .filter((chat) => isSafeChatId(chat?.chatId))
      .map((chat) => chatDocumentStorageKey(key, chat.chatId)),
    ...discoveredDocuments,
  ];
}

/** Every key owned by chat persistence, including keys no record/chat index can
 * currently discover. Used by deleteAll as the final defense against orphans. */
export async function allChatStorageKeys() {
  const allItems = await getLocalByPrefix(CHAT_STORAGE_PREFIX);
  return Object.keys(allItems).filter((storageKey) => storageKey.startsWith(CHAT_STORAGE_PREFIX));
}

/**
 * Rebuilds chat indexes from valid same-revision documents and removes data
 * that no longer has a record owner or belongs to superseded record content.
 * The scan is globally serialized with every record/chat mutation, so it can
 * safely repair interrupted multi-key operations without racing new writes.
 *
 * Documents are authoritative for recovery: a valid unindexed document is
 * re-listed so the user can see and delete it. Stale/recordless documents are
 * removed before repaired indexes are written; if the index write then fails,
 * the remaining documents are still discoverable by the next scan.
 */
export async function reconcileChatStorage() {
  return queuedChatUpdate(MUTATION_QUEUE_KEY, async () => {
    const allItems = await getLocalByPrefix(CHAT_STORAGE_PREFIX);
    const groups = new Map();
    const invalidKeys = [];

    const groupFor = (key) => {
      let group = groups.get(key);
      if (!group) {
        group = { indexKey: chatIndexStorageKey(key), documents: new Map() };
        groups.set(key, group);
      }
      return group;
    };

    for (const [storageKey, value] of Object.entries(allItems)) {
      if (!storageKey.startsWith(CHAT_STORAGE_PREFIX)) continue;
      const indexRecordKey = recordKeyFromChatIndexStorageKey(storageKey);
      if (indexRecordKey) {
        groupFor(indexRecordKey).storedIndex = value;
        continue;
      }
      const documentRecordKey = recordKeyFromChatDocumentStorageEntry(storageKey, value);
      if (documentRecordKey) {
        groupFor(documentRecordKey).documents.set(storageKey, value);
      } else {
        invalidKeys.push(storageKey);
      }
    }

    const metaKeys = [...groups.keys()].map((key) => recordMetaStorageKey(key));
    const recordMetas = metaKeys.length ? await getLocal(metaKeys) : {};

    const removeKeys = new Set(invalidKeys);
    const indexWrites = {};
    let keptChats = 0;

    for (const [key, group] of groups) {
      const meta = recordMetas[recordMetaStorageKey(key)];
      const contentRevision = meta
        ? typeof meta.contentRevision === 'string' && meta.contentRevision
          ? meta.contentRevision
          : 'legacy'
        : null;

      if (!contentRevision) {
        removeKeys.add(group.indexKey);
        for (const storageKey of group.documents.keys()) removeKeys.add(storageKey);
        continue;
      }

      const chats = [];
      const mappings = [];
      for (const [storageKey, chat] of group.documents) {
        if (!isCompatible(chat, contentRevision)) {
          removeKeys.add(storageKey);
          continue;
        }
        chats.push(chatSummary(chat));
        mappings.push(...chatTurnMappings(chat));
      }

      if (chats.length === 0) {
        removeKeys.add(group.indexKey);
        continue;
      }

      chats.sort((a, b) => b.updatedAt - a.updatedAt);
      mappings.sort((a, b) => a.at - b.at || a.order - b.order);
      const uniqueMappings = new Map();
      for (const mapping of mappings) uniqueMappings.set(mapping.turnId, mapping);
      const repairedIndex = {
        chats,
        turns: [...uniqueMappings.values()]
          .slice(-MAX_TURN_INDEX_ENTRIES)
          .map(({ turnId, chatId }) => ({ turnId, chatId })),
      };
      if (!sameStoredValue(normalizedStoredIndex(group.storedIndex), repairedIndex)) {
        indexWrites[group.indexKey] = repairedIndex;
      }
      keptChats += chats.length;
    }

    if (removeKeys.size) await removeLocal([...removeKeys]);
    if (Object.keys(indexWrites).length) await setLocal(indexWrites);

    return {
      records: groups.size,
      keptChats,
      removedKeys: removeKeys.size,
    };
  });
}
