import { useCallback, useEffect, useRef, useState } from 'react';
import { getStoredChat, listStoredChats, removeStoredChat } from './chatApi.js';

/** Map a stored highlight_span event to a paintable sentence range.
 * @param {object} event Stored chat event.
 */
export function eventRange(event) {
  if (event?.eventType !== 'highlight_span') return null;
  const startLine = Number(event.data?.startLine);
  const endLine = Number(event.data?.endLine);
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) return null;
  return { startLine, endLine, label: event.data?.label || '' };
}

function eventsForTurn(events, event) {
  if (!event) return [];
  return event.turnId ? events.filter((candidate) => candidate.turnId === event.turnId) : [event];
}

const USE_LATEST_EVENT = Symbol('use latest event');

/**
 * Owns the persisted chat sessions of one record. Loads are latest-wins and
 * mutations are serialized so stale async completions cannot overwrite a
 * newer selection. `applyEvents` paints the evidence belonging to the active
 * turn; the complete `events` list remains historical/auditable data.
 *
 * @param {{
 *   recordKey: string,
 *   applyEvents: (events: object[], options?: {focusEvent?: object}) => void,
 * }} options
 */
export function useChatSessions({ recordKey, applyEvents }) {
  const [chats, setChats] = useState([]);
  const [activeChatId, setActiveChatId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [events, setEvents] = useState([]);
  const [paintedEvents, setPaintedEvents] = useState([]);
  const [selectedEventSeq, setSelectedEventSeq] = useState(null);
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);
  const [isMutatingHistory, setIsMutatingHistory] = useState(false);
  const [error, setError] = useState('');

  const mountedRef = useRef(true);
  const recordKeyRef = useRef(recordKey);
  const activeChatIdRef = useRef(activeChatId);
  const loadGenerationRef = useRef(0);
  const mutationQueueRef = useRef(Promise.resolve());

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      loadGenerationRef.current += 1;
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
      setActiveChatId(activeChatIdRef.current);
      setMessages(nextMessages);
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
        const chat = await getStoredChat(requestedRecordKey, chatId);
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
    [adoptChat, recordKey],
  );

  const refreshChats = useCallback(async () => {
    if (!recordKey) return [];
    const requestedRecordKey = recordKey;
    const nextChats = await listStoredChats(requestedRecordKey);
    if (mountedRef.current && requestedRecordKey === recordKeyRef.current) setChats(nextChats);
    return nextChats;
  }, [recordKey]);

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
    listStoredChats(recordKey)
      .then(async (nextChats) => {
        if (cancelled || generation !== loadGenerationRef.current) return;
        setChats(nextChats);
        if (nextChats.length) {
          const chat = await getStoredChat(recordKey, nextChats[0].chatId);
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
  }, [adoptChat, recordKey]);

  const startNewChat = useCallback(() => {
    loadGenerationRef.current += 1;
    setIsLoadingHistory(false);
    adoptChat(null);
    setError('');
  }, [adoptChat]);

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
          await removeStoredChat(requestedRecordKey, chatId);
          const nextChats = await listStoredChats(requestedRecordKey);
          if (!mountedRef.current || requestedRecordKey !== recordKeyRef.current) return true;
          setChats(nextChats);
          if (chatId === activeChatIdRef.current) {
            if (nextChats.length) await loadChat(nextChats[0].chatId);
            else startNewChat();
          }
          return true;
        } catch (err) {
          if (mountedRef.current) setError(err?.message || 'Failed to delete chat.');
          return false;
        } finally {
          if (mountedRef.current) setIsMutatingHistory(false);
        }
      }),
    [enqueueMutation, loadChat, startNewChat],
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
        const chat = await getStoredChat(recordKey, chatId);
        if (!chat?.messages?.some((message) => message.turnId === turnId)) return false;
        if (!mountedRef.current || activeChatIdRef.current !== chatId) return false;
        const turnEvents = chat.events.filter((event) => event.turnId === turnId);
        adoptChat(chat, turnEvents.at(-1) || null);
        return true;
      } catch {
        return false;
      }
    },
    [adoptChat, recordKey],
  );

  return {
    chats,
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
