import { useCallback, useEffect, useRef, useState } from 'react';
import { normalizeChatScope } from './topicScope.js';

/** Map a stored highlight_span event to a paintable sentence range. A project
 * chat's page highlight also keeps its page (`pageUrl`, `pageTitle`, `page`)
 * and the cited lines as captured (`excerpt`).
 * @param {object} event Stored chat event.
 */
export function eventRange(event) {
  if (event?.eventType !== 'highlight_span') return null;
  const data = event.data || {};
  const startLine = Number(data.startLine);
  const endLine = Number(data.endLine);
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) return null;
  const range = { startLine, endLine, label: data.label || '' };
  if (typeof data.pageUrl === 'string' && data.pageUrl) {
    range.pageUrl = data.pageUrl;
    range.pageTitle = typeof data.pageTitle === 'string' ? data.pageTitle : '';
    if (Number.isInteger(data.page)) range.page = data.page;
    if (Array.isArray(data.excerpt)) range.excerpt = data.excerpt.map((line) => String(line ?? ''));
  }
  return range;
}

function eventsForTurn(events, event) {
  if (!event) return [];
  return event.turnId ? events.filter((candidate) => candidate.turnId === event.turnId) : [event];
}

const USE_LATEST_EVENT = Symbol('use latest event');

/**
 * Manage one record's chat sessions. Latest-wins loads and serialized mutations
 * prevent stale completions from replacing the current selection. `applyEvents`
 * paints the active turn while `events` retains the full history.
 *
 * @param {object} options
 * @param {string} options.recordKey
 * @param {function(object[], object=): void} options.applyEvents events, options: {focusEvent?: object}
 * @param {{list: Function, get: Function, remove: Function}} options.chatRepository
 */
export function useChatSessions({ recordKey, applyEvents, chatRepository }) {
  const [chats, setChats] = useState([]);
  const [scope, setScope] = useState([]);
  const [activeChatId, setActiveChatId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [events, setEvents] = useState([]);
  const [paintedEvents, setPaintedEvents] = useState([]);
  const [selectedEventSeq, setSelectedEventSeq] = useState(null);
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);
  const [isMutatingHistory, setIsMutatingHistory] = useState(false);
  const [error, setError] = useState('');

  // Depend on stable port functions so inline repository wrappers do not reload history.
  const { list: listChats, get: getChat, remove: removeChat } = chatRepository;

  const mountedRef = useRef(true);
  const recordKeyRef = useRef(recordKey);
  const activeChatIdRef = useRef(activeChatId);
  // A hidden Activity resumes its effects. Keep an explicitly scoped draft
  // instead of replacing it with the latest (possibly whole-document) chat.
  const scopedDraftRef = useRef(null);
  const loadGenerationRef = useRef(0);
  const mutationQueueRef = useRef(Promise.resolve());

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      loadGenerationRef.current += 1;
      // <Activity> preserves state while hidden; clear busy flags for reopening.
      setIsLoadingHistory(false);
      setIsMutatingHistory(false);
    };
  }, []);

  useEffect(() => {
    recordKeyRef.current = recordKey;
  }, [recordKey]);

  const adoptChat = useCallback(
    (chat, preferredEvent = USE_LATEST_EVENT) => {
      const nextMessages = Array.isArray(chat?.messages) ? chat.messages : [];
      const nextEvents = Array.isArray(chat?.events) ? chat.events : [];
      const selected =
        preferredEvent === USE_LATEST_EVENT ? nextEvents.at(-1) || null : preferredEvent;
      const nextPaintedEvents = eventsForTurn(nextEvents, selected);
      activeChatIdRef.current = chat?.chatId || null;
      scopedDraftRef.current =
        !chat?.chatId && chat?.scope?.length ? { recordKey: recordKeyRef.current } : null;
      setActiveChatId(activeChatIdRef.current);
      setMessages(nextMessages);
      setScope(normalizeChatScope(chat?.scope));
      setEvents(nextEvents);
      setPaintedEvents(nextPaintedEvents);
      setSelectedEventSeq(selected?.seq ?? null);
      applyEvents(nextPaintedEvents);
    },
    [applyEvents],
  );

  const loadChat = useCallback(
    async (chatId) => {
      if (!recordKey || !chatId) return false;
      const generation = loadGenerationRef.current + 1;
      loadGenerationRef.current = generation;
      const requestedRecordKey = recordKey;
      setIsLoadingHistory(true);
      setError('');
      try {
        const chat = await getChat(requestedRecordKey, chatId);
        if (
          !mountedRef.current ||
          generation !== loadGenerationRef.current ||
          requestedRecordKey !== recordKeyRef.current
        ) {
          return false;
        }
        adoptChat(chat);
        return true;
      } catch (err) {
        if (mountedRef.current && generation === loadGenerationRef.current) {
          setError(err?.message || 'Failed to load chat history.');
        }
        return false;
      } finally {
        if (mountedRef.current && generation === loadGenerationRef.current) {
          setIsLoadingHistory(false);
        }
      }
    },
    [adoptChat, getChat, recordKey],
  );

  const refreshChats = useCallback(async () => {
    if (!recordKey) return [];
    const requestedRecordKey = recordKey;
    const nextChats = await listChats(requestedRecordKey);
    if (mountedRef.current && requestedRecordKey === recordKeyRef.current) setChats(nextChats);
    return nextChats;
  }, [listChats, recordKey]);

  useEffect(() => {
    let cancelled = false;
    const generation = loadGenerationRef.current + 1;
    loadGenerationRef.current = generation;
    Promise.resolve().then(() => {
      if (!cancelled && generation === loadGenerationRef.current) {
        setIsLoadingHistory(true);
        setError('');
      }
    });
    listChats(recordKey)
      .then(async (nextChats) => {
        if (cancelled || generation !== loadGenerationRef.current) return;
        setChats(nextChats);
        if (scopedDraftRef.current?.recordKey === recordKey) return;
        if (nextChats.length) {
          const chat = await getChat(recordKey, nextChats[0].chatId);
          if (cancelled || generation !== loadGenerationRef.current) return;
          adoptChat(chat);
        } else {
          adoptChat(null);
        }
      })
      .catch((err) => {
        if (!cancelled && generation === loadGenerationRef.current) {
          setError(err?.message || 'Failed to load chat history.');
        }
      })
      .finally(() => {
        if (!cancelled && generation === loadGenerationRef.current) setIsLoadingHistory(false);
      });
    return () => {
      cancelled = true;
      if (generation === loadGenerationRef.current) loadGenerationRef.current += 1;
    };
  }, [adoptChat, getChat, listChats, recordKey]);

  const startNewChat = useCallback(
    (nextScope = []) => {
      loadGenerationRef.current += 1;
      setIsLoadingHistory(false);
      adoptChat({ scope: nextScope });
      setError('');
    },
    [adoptChat],
  );

  const selectEvent = useCallback(
    (event) => {
      const nextPaintedEvents = eventsForTurn(events, event);
      setSelectedEventSeq(event.seq);
      setPaintedEvents(nextPaintedEvents);
      applyEvents(nextPaintedEvents, { focusEvent: event });
    },
    [applyEvents, events],
  );

  const clearSelection = useCallback(() => {
    setSelectedEventSeq(null);
    setPaintedEvents([]);
    applyEvents([]);
  }, [applyEvents]);

  const enqueueMutation = useCallback((mutation) => {
    const queued = mutationQueueRef.current.catch(() => {}).then(mutation);
    mutationQueueRef.current = queued;
    return queued;
  }, []);

  const deleteChat = useCallback(
    (chatId) =>
      enqueueMutation(async () => {
        if (!chatId) return false;
        const requestedRecordKey = recordKeyRef.current;
        if (mountedRef.current) {
          setIsMutatingHistory(true);
          setError('');
        }
        try {
          await removeChat(requestedRecordKey, chatId);
          // Leave the deleted chat before the fallible re-list: if the list
          // throws, the session must not stay bound to an id that no longer
          // exists, or every later save would fail with 'chat not found'.
          const wasActive =
            mountedRef.current &&
            requestedRecordKey === recordKeyRef.current &&
            chatId === activeChatIdRef.current;
          if (wasActive) startNewChat();
          const nextChats = await listChats(requestedRecordKey);
          if (!mountedRef.current || requestedRecordKey !== recordKeyRef.current) return true;
          setChats(nextChats);
          if (wasActive && nextChats.length && activeChatIdRef.current === null) {
            await loadChat(nextChats[0].chatId);
          }
          return true;
        } catch (err) {
          if (mountedRef.current) setError(err?.message || 'Failed to delete chat.');
          return false;
        } finally {
          if (mountedRef.current) setIsMutatingHistory(false);
        }
      }),
    [enqueueMutation, listChats, loadChat, removeChat, startNewChat],
  );

  /** Adopt a persist response only if the operation still targets this session. */
  const adoptPersistedTurn = useCallback(
    (persisted, { expectedChatId = null, turnId } = {}) => {
      if (activeChatIdRef.current !== expectedChatId) return false;
      const authoritativeChat = persisted?.chat;
      if (!authoritativeChat?.chatId) return false;
      const turnEvents = authoritativeChat.events.filter(
        (event) => turnId && event.turnId === turnId,
      );
      adoptChat(authoritativeChat, turnEvents.at(-1) || null);
      return true;
    },
    [adoptChat],
  );

  /** Reconcile an append whose response may have been lost after storage committed. */
  const reconcilePersistedTurn = useCallback(
    async (chatId, turnId) => {
      if (!chatId || !turnId) return false;
      try {
        const chat = await getChat(recordKey, chatId);
        if (!chat?.messages?.some((message) => message.turnId === turnId)) return false;
        if (!mountedRef.current || activeChatIdRef.current !== chatId) return false;
        const turnEvents = chat.events.filter((event) => event.turnId === turnId);
        adoptChat(chat, turnEvents.at(-1) || null);
        return true;
      } catch {
        return false;
      }
    },
    [adoptChat, getChat, recordKey],
  );

  return {
    chats,
    scope,
    activeChatId,
    messages,
    events,
    paintedEvents,
    selectedEventSeq,
    isLoadingHistory,
    isMutatingHistory,
    error,
    setError,
    loadChat,
    refreshChats,
    startNewChat,
    selectEvent,
    clearSelection,
    deleteChat,
    adoptPersistedTurn,
    reconcilePersistedTurn,
  };
}
