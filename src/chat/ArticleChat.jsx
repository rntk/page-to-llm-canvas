import React, { useCallback, useMemo, useState } from 'react';
import { runArticleChatTurn } from './articleChat.js';
import { persistChatTurn } from './chatApi.js';
import { eventRange, useChatSessions } from './useChatSessions.js';
import ChatComposer from './ChatComposer.jsx';
import ChatEventsList from './ChatEventsList.jsx';
import ChatHistoryPanel from './ChatHistoryPanel.jsx';
import ChatMessageList from './ChatMessageList.jsx';

/**
 * Article chat panel: composes the persisted-session hook with the
 * presentational pieces and owns the send path. One LLM turn runs entirely
 * in memory (highlights are live-painted as they stream in) and is then
 * committed with a single persistChatTurn call, so a failure anywhere leaves
 * storage exactly as it was.
 *
 * @param {{
 *   recordKey: string,
 *   sentences: string[],
 *   onHighlight?: (range: object) => void,
 *   onClearHighlights?: () => void,
 *   onClose?: () => void,
 * }} props
 */
export default function ArticleChat({
  recordKey,
  sentences,
  onHighlight,
  onClearHighlights,
  onClose,
}) {
  const [input, setInput] = useState('');
  const [activeTab, setActiveTab] = useState('chat');
  const [autoFocusEvents, setAutoFocusEvents] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  // Optimistic user bubble while the turn runs; nothing is persisted yet.
  const [pendingQuestion, setPendingQuestion] = useState('');

  const applyEvent = useCallback(
    (event, { focus = false } = {}) => {
      onClearHighlights?.();
      const range = eventRange(event);
      if (range) {
        if (focus) onHighlight?.(range, { focus: true });
        else onHighlight?.(range);
      }
    },
    [onClearHighlights, onHighlight],
  );

  const {
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
  } = useChatSessions({ recordKey, applyEvent });

  // Single source of truth: ranges are always derived from the events state.
  const highlightedRanges = useMemo(() => events.map(eventRange).filter(Boolean), [events]);

  const visibleMessages = useMemo(() => {
    const visible = messages.filter((message) => !message.hidden);
    return pendingQuestion ? [...visible, { role: 'user', content: pendingQuestion }] : visible;
  }, [messages, pendingQuestion]);

  const handleSelectChat = useCallback(
    async (chatId) => {
      if (await loadChat(chatId)) setShowHistory(false);
    },
    [loadChat],
  );

  const handleNewChat = useCallback(() => {
    if (isLoading) return;
    startNewChat();
    setInput('');
    setShowHistory(false);
    setActiveTab('chat');
  }, [isLoading, startNewChat]);

  const handleDeleteChat = useCallback(
    (chatId) => {
      if (isLoading) return;
      void deleteChat(chatId);
    },
    [deleteChat, isLoading],
  );

  const send = useCallback(async () => {
    const question = input.trim();
    if (!question || isLoading || !recordKey) return;
    setInput('');
    setError('');
    setIsLoading(true);
    setPendingQuestion(question);
    try {
      try {
        // Run the whole turn first; onHighlight only live-paints the article.
        const result = await runArticleChatTurn({
          history: messages,
          question,
          sentences,
          highlightedRanges,
          onHighlight: (range) => {
            if (autoFocusEvents) return onHighlight?.(range, { focus: true });
            return onHighlight?.(range);
          },
        });
        // Commit the turn as one atomic write. A falsy chatId creates the chat
        // inline, so a failed first turn leaves no orphan chat behind.
        const persisted = await persistChatTurn(recordKey, activeChatId ?? null, {
          messages: [
            { role: 'user', content: question },
            ...result.transcriptMessages.map((message) => ({ ...message, hidden: true })),
            { role: 'assistant', content: result.reply },
          ],
          events: result.highlightRanges.map((range) => ({
            eventType: 'highlight_span',
            data: range,
          })),
        });
        adoptPersistedTurn(persisted);
        setPendingQuestion('');
      } catch (err) {
        // Nothing was persisted: undo the live-painted highlights by repainting
        // the stored selection, and give the question back to the composer.
        setPendingQuestion('');
        setInput(question);
        applyEvent(events.find((event) => event.seq === selectedEventSeq) ?? null);
        setError(err?.message || 'Failed to get a response.');
        return;
      }
      // The turn is durably persisted and adopted; the chat-list refresh is a
      // runtime round-trip whose only effect is cosmetic sidebar titles/counts.
      // A failure here must neither roll back the turn nor surface an error.
      try {
        await refreshChats();
      } catch {
        // Stale sidebar titles/counts are acceptable; the turn is persisted.
      }
    } finally {
      setIsLoading(false);
    }
  }, [
    activeChatId,
    adoptPersistedTurn,
    applyEvent,
    autoFocusEvents,
    events,
    highlightedRanges,
    input,
    isLoading,
    messages,
    onHighlight,
    recordKey,
    refreshChats,
    selectedEventSeq,
    sentences,
    setError,
  ]);

  return (
    <section className="pagetollm-chat" onMouseDown={(event) => event.stopPropagation()}>
      <header className="pagetollm-chat-header">
        <div>
          <div className="pagetollm-chat-title">Article assistant</div>
          <div className="pagetollm-chat-subtitle">Ask about this article</div>
        </div>
        <div className="pagetollm-chat-actions">
          <button type="button" onClick={() => setShowHistory((value) => !value)}>
            History
          </button>
          <button type="button" onClick={handleNewChat} disabled={isLoading}>
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
        <ChatHistoryPanel
          chats={chats}
          activeChatId={activeChatId}
          onSelectChat={(chatId) => void handleSelectChat(chatId)}
          onDeleteChat={handleDeleteChat}
        />
      ) : null}

      <div className="pagetollm-chat-tabs">
        <button
          type="button"
          className={activeTab === 'chat' ? 'is-active' : ''}
          onClick={() => setActiveTab('chat')}
        >
          Chat
        </button>
        <div className={`pagetollm-chat-events-tab${activeTab === 'events' ? ' is-active' : ''}`}>
          <button type="button" onClick={() => setActiveTab('events')}>
            Events <span>{events.length}</span>
          </button>
          <label title="Automatically scroll/zoom to new events">
            <input
              type="checkbox"
              checked={autoFocusEvents}
              onChange={(event) => setAutoFocusEvents(event.target.checked)}
            />
            Live
          </label>
        </div>
      </div>

      {activeTab === 'events' ? (
        <ChatEventsList
          events={events}
          selectedEventSeq={selectedEventSeq}
          onSelectEvent={selectEvent}
          onDeleteEvent={(event) => void deleteEvent(event)}
        />
      ) : (
        <>
          <ChatMessageList
            messages={visibleMessages}
            isLoading={isLoading}
            isLoadingHistory={isLoadingHistory}
          />
          <ChatComposer
            value={input}
            onChange={setInput}
            onSend={() => void send()}
            disabled={isLoading || isLoadingHistory}
          />
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
