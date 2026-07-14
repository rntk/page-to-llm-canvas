import { useCallback, useEffect, useState } from 'react';
import {
  getStoredChat,
  listStoredChats,
  removeStoredChat,
  removeStoredChatEvent,
} from './chatApi.js';

/** Map a stored highlight_span event to a paintable sentence range. */
export function eventRange(event) {
  if (event?.eventType !== 'highlight_span') return null;
  const startLine = Number(event.data?.startLine);
  const endLine = Number(event.data?.endLine);
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) return null;
  return { startLine, endLine, label: event.data?.label || '' };
}

/**
 * Owns the persisted chat sessions of one record: the chats list, the active
 * chat's messages/events, and the load/delete operations against chatApi.
 * The send path stays with the caller; it hands its atomically persisted
 * result to `adoptPersistedTurn`.
 *
 * `applyEvent(event | null)` must repaint the article highlights for one
 * stored event (or clear them for null); it is invoked whenever the selected
 * event changes because of a load or delete.
 *
 * @param {{ recordKey: string, applyEvent: (event: object | null) => void }} options
 */
export function useChatSessions({ recordKey, applyEvent }) {
  const [chats, setChats] = useState([]);
  const [activeChatId, setActiveChatId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [events, setEvents] = useState([]);
  const [selectedEventSeq, setSelectedEventSeq] = useState(null);
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);
  const [error, setError] = useState('');

  const loadChat = useCallback(
    async (chatId) => {
      if (!recordKey || !chatId) return false;
      setIsLoadingHistory(true);
      setError('');
      try {
        const chat = await getStoredChat(recordKey, chatId);
        const nextEvents = Array.isArray(chat?.events) ? chat.events : [];
        setActiveChatId(chatId);
        setMessages(Array.isArray(chat?.messages) ? chat.messages : []);
        setEvents(nextEvents);
        const latest = nextEvents.at(-1) || null;
        setSelectedEventSeq(latest?.seq ?? null);
        applyEvent(latest);
        return true;
      } catch (err) {
        setError(err?.message || 'Failed to load chat history.');
        return false;
      } finally {
        setIsLoadingHistory(false);
      }
    },
    [applyEvent, recordKey],
  );

  const refreshChats = useCallback(async () => {
    if (!recordKey) return [];
    const nextChats = await listStoredChats(recordKey);
    setChats(nextChats);
    return nextChats;
  }, [recordKey]);

  useEffect(() => {
    let cancelled = false;
    listStoredChats(recordKey)
      .then(async (nextChats) => {
        if (cancelled) return;
        setChats(nextChats);
        if (nextChats.length) await loadChat(nextChats[0].chatId);
        else applyEvent(null);
      })
      .catch((err) => {
        if (!cancelled) setError(err?.message || 'Failed to load chat history.');
      })
      .finally(() => {
        if (!cancelled) setIsLoadingHistory(false);
      });
    return () => {
      cancelled = true;
    };
  }, [applyEvent, loadChat, recordKey]);

  const startNewChat = useCallback(() => {
    setActiveChatId(null);
    setMessages([]);
    setEvents([]);
    setSelectedEventSeq(null);
    setError('');
    applyEvent(null);
  }, [applyEvent]);

  const selectEvent = useCallback(
    (event) => {
      setSelectedEventSeq(event.seq);
      applyEvent(event);
    },
    [applyEvent],
  );

  const deleteEvent = useCallback(
    async (event) => {
      if (!activeChatId) return;
      setError('');
      try {
        await removeStoredChatEvent(recordKey, activeChatId, event.seq);
        const nextEvents = events.filter((item) => item.seq !== event.seq);
        setEvents(nextEvents);
        const latest = nextEvents.at(-1) || null;
        setSelectedEventSeq(latest?.seq ?? null);
        applyEvent(latest);
        await refreshChats();
      } catch (err) {
        setError(err?.message || 'Failed to delete event.');
      }
    },
    [activeChatId, applyEvent, events, recordKey, refreshChats],
  );

  const deleteChat = useCallback(
    async (chatId) => {
      if (!chatId) return;
      setError('');
      try {
        await removeStoredChat(recordKey, chatId);
        const nextChats = await refreshChats();
        if (chatId === activeChatId) {
          if (nextChats.length) await loadChat(nextChats[0].chatId);
          else startNewChat();
        }
      } catch (err) {
        setError(err?.message || 'Failed to delete chat.');
      }
    },
    [activeChatId, loadChat, recordKey, refreshChats, startNewChat],
  );

  /**
   * Adopt the normalized result of persistChatTurn: the returned chat doc is
   * authoritative (a new chat contributes its chatId, the events array is the
   * complete list with assigned seqs) and the returned messages carry their
   * storage ids.
   */
  const adoptPersistedTurn = useCallback(({ chat, messages: newMessages, events: newEvents }) => {
    setActiveChatId(chat.chatId);
    setMessages((current) => [...current, ...(Array.isArray(newMessages) ? newMessages : [])]);
    setEvents(Array.isArray(chat.events) ? chat.events : []);
    const latest = Array.isArray(newEvents) ? newEvents.at(-1) : null;
    if (latest) setSelectedEventSeq(latest.seq);
  }, []);

  return {
    chats,
    activeChatId,
    messages,
    events,
    selectedEventSeq,
    isLoadingHistory,
    error,
    setError,
    loadChat,
    refreshChats,
    startNewChat,
    selectEvent,
    deleteEvent,
    deleteChat,
    adoptPersistedTurn,
  };
}
