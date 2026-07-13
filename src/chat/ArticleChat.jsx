import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { runArticleChatTurn } from './articleChat.js';
import {
  createStoredChat,
  getStoredChat,
  listStoredChats,
  persistChatEvent,
  persistChatMessage,
  removeStoredChat,
  removeStoredChatEvent,
} from './chatApi.js';

function eventRange(event) {
  if (event?.eventType !== 'highlight_span') return null;
  const startLine = Number(event.data?.startLine);
  const endLine = Number(event.data?.endLine);
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) return null;
  return { startLine, endLine, label: event.data?.label || '' };
}

function formatDate(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
}

export default function ArticleChat({
  recordKey,
  sentences,
  onHighlight,
  onClearHighlights,
  onClose,
}) {
  const [chats, setChats] = useState([]);
  const [activeChatId, setActiveChatId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [events, setEvents] = useState([]);
  const [selectedEventSeq, setSelectedEventSeq] = useState(null);
  const [input, setInput] = useState('');
  const [activeTab, setActiveTab] = useState('chat');
  const [showHistory, setShowHistory] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);
  const [error, setError] = useState('');
  const highlightedRangesRef = useRef([]);
  const endRef = useRef(null);

  const visibleMessages = useMemo(() => messages.filter((message) => !message.hidden), [messages]);

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ behavior: 'smooth' });
  }, [visibleMessages, isLoading]);

  const applyEvent = useCallback(
    (event) => {
      onClearHighlights?.();
      const range = eventRange(event);
      if (range) onHighlight?.(range);
    },
    [onClearHighlights, onHighlight],
  );

  const loadChat = useCallback(
    async (chatId) => {
      if (!recordKey || !chatId) return;
      setIsLoadingHistory(true);
      setError('');
      try {
        const chat = await getStoredChat(recordKey, chatId);
        const nextEvents = Array.isArray(chat?.events) ? chat.events : [];
        setActiveChatId(chatId);
        setMessages(Array.isArray(chat?.messages) ? chat.messages : []);
        setEvents(nextEvents);
        highlightedRangesRef.current = nextEvents.map(eventRange).filter(Boolean);
        const latest = nextEvents.at(-1) || null;
        setSelectedEventSeq(latest?.seq ?? null);
        applyEvent(latest);
        setShowHistory(false);
      } catch (err) {
        setError(err?.message || 'Failed to load chat history.');
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
        else onClearHighlights?.();
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
  }, [loadChat, onClearHighlights, recordKey]);

  const startNewChat = useCallback(() => {
    if (isLoading) return;
    setActiveChatId(null);
    setMessages([]);
    setEvents([]);
    setSelectedEventSeq(null);
    setInput('');
    setError('');
    setShowHistory(false);
    setActiveTab('chat');
    highlightedRangesRef.current = [];
    onClearHighlights?.();
  }, [isLoading, onClearHighlights]);

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
        highlightedRangesRef.current = nextEvents.map(eventRange).filter(Boolean);
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
      if (!chatId || isLoading) return;
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
    [activeChatId, isLoading, loadChat, recordKey, refreshChats, startNewChat],
  );

  const send = useCallback(async () => {
    const question = input.trim();
    if (!question || isLoading || !recordKey) return;
    const history = messages;
    setInput('');
    setError('');
    setIsLoading(true);
    try {
      let chatId = activeChatId;
      if (!chatId) {
        const chat = await createStoredChat(recordKey);
        chatId = chat.chatId;
        setActiveChatId(chatId);
      }
      const userMessage = await persistChatMessage(recordKey, chatId, {
        role: 'user',
        content: question,
      });
      setMessages((current) => [...current, userMessage]);

      const result = await runArticleChatTurn({
        history,
        question,
        sentences,
        highlightedRanges: highlightedRangesRef.current,
        onTranscriptMessage: async (message) => {
          const storedMessage = await persistChatMessage(recordKey, chatId, {
            ...message,
            hidden: true,
          });
          setMessages((current) => [...current, storedMessage]);
        },
        onHighlight: async (range) => {
          const event = await persistChatEvent(recordKey, chatId, {
            eventType: 'highlight_span',
            data: range,
          });
          setEvents((current) => [...current, event]);
          setSelectedEventSeq(event.seq);
          onHighlight?.(range);
        },
      });
      const assistantMessage = await persistChatMessage(recordKey, chatId, {
        role: 'assistant',
        content: result.reply,
      });
      setMessages((current) => [...current, assistantMessage]);
      await refreshChats();
    } catch (err) {
      setError(err?.message || 'Failed to get a response.');
    } finally {
      setIsLoading(false);
    }
  }, [activeChatId, input, isLoading, messages, onHighlight, recordKey, refreshChats, sentences]);

  const handleKeyDown = useCallback(
    (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        void send();
      }
    },
    [send],
  );

  return (
    <section className="pagetollm-chat" onMouseDown={(event) => event.stopPropagation()}>
      <header className="pagetollm-chat-header">
        <div>
          <div className="pagetollm-chat-title">Article assistant</div>
          <div className="pagetollm-chat-subtitle">llama.cpp</div>
        </div>
        <div className="pagetollm-chat-actions">
          <button type="button" onClick={() => setShowHistory((value) => !value)}>
            History
          </button>
          <button type="button" onClick={startNewChat} disabled={isLoading}>
            New
          </button>
          {onClose ? (
            <button type="button" onClick={onClose} aria-label="Close chat" title="Close chat">
              ×
            </button>
          ) : null}
        </div>
      </header>

      {showHistory ? (
        <div className="pagetollm-chat-history-panel">
          {chats.length === 0 ? <div className="pagetollm-chat-empty">No chats yet.</div> : null}
          {chats.map((chat) => (
            <div
              key={chat.chatId}
              className={`pagetollm-chat-history-item${chat.chatId === activeChatId ? ' is-active' : ''}`}
            >
              <button type="button" onClick={() => void loadChat(chat.chatId)}>
                <strong>{chat.title || 'New chat'}</strong>
                <span>
                  {formatDate(chat.updatedAt)} · {chat.messageCount} msg · {chat.eventCount} ev
                </span>
              </button>
              <button
                type="button"
                className="is-delete"
                onClick={() => void deleteChat(chat.chatId)}
                aria-label={`Delete ${chat.title || 'chat'}`}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <div className="pagetollm-chat-tabs">
        <button
          type="button"
          className={activeTab === 'chat' ? 'is-active' : ''}
          onClick={() => setActiveTab('chat')}
        >
          Chat
        </button>
        <button
          type="button"
          className={activeTab === 'events' ? 'is-active' : ''}
          onClick={() => setActiveTab('events')}
        >
          Events <span>{events.length}</span>
        </button>
      </div>

      {activeTab === 'events' ? (
        <div className="pagetollm-chat-events" role="list">
          {events.length === 0 ? (
            <div className="pagetollm-chat-empty">No events in this chat.</div>
          ) : null}
          {events.map((event, index) => {
            const range = eventRange(event);
            return (
              <div
                key={event.seq}
                className={`pagetollm-chat-event${event.seq === selectedEventSeq ? ' is-active' : ''}`}
                role="listitem"
              >
                <button type="button" onClick={() => selectEvent(event)}>
                  <strong>#{index + 1} Highlight</strong>
                  <span>
                    Lines {range?.startLine ?? '?'}–{range?.endLine ?? '?'}
                    {range?.label ? ` · ${range.label}` : ''}
                  </span>
                </button>
                <button
                  type="button"
                  className="is-delete"
                  onClick={() => void deleteEvent(event)}
                  aria-label={`Delete event ${index + 1}`}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      ) : (
        <>
          <div className="pagetollm-chat-history" aria-live="polite">
            {visibleMessages.length === 0 ? (
              <div className="pagetollm-chat-empty">Ask a question about this article.</div>
            ) : null}
            {visibleMessages.map((message, index) => (
              <div
                key={message.id || `${message.role}-${index}`}
                className={`pagetollm-chat-message is-${message.role}`}
              >
                <strong>{message.role === 'user' ? 'You' : 'Assistant'}</strong>
                <span>{message.content}</span>
              </div>
            ))}
            {isLoading || isLoadingHistory ? (
              <div className="pagetollm-chat-message is-assistant is-loading">
                <strong>Assistant</strong>
                <span>{isLoading ? 'Thinking…' : 'Loading history…'}</span>
              </div>
            ) : null}
            <div ref={endRef} />
          </div>

          <div className="pagetollm-chat-composer">
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask about this article…"
              rows={3}
              disabled={isLoading || isLoadingHistory}
              aria-label="Message"
            />
            <button
              type="button"
              onClick={() => void send()}
              disabled={!input.trim() || isLoading || isLoadingHistory}
            >
              Send
            </button>
          </div>
        </>
      )}

      {error ? (
        <div className="pagetollm-chat-error" role="alert">
          {error}
        </div>
      ) : null}
    </section>
  );
}
