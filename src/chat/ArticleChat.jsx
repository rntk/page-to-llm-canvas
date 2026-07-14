import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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
 *   onEscape?: () => void,
 *   headerActionsTarget?: HTMLElement | null,
 *   subject?: 'article' | 'video',
 *   getEventTimestamp?: (range: object) => number | null,
 * }} props
 */
export default function ArticleChat({
  recordKey,
  sentences,
  onHighlight,
  onClearHighlights,
  onClose,
  onEscape,
  headerActionsTarget,
  subject = 'article',
  getEventTimestamp,
}) {
  const panelId = useId();
  const subjectLabel = subject === 'video' ? 'video' : 'article';
  const subjectTitle = `${subjectLabel[0].toUpperCase()}${subjectLabel.slice(1)}`;
  const [input, setInput] = useState('');
  const [activeTab, setActiveTab] = useState('chat');
  const [autoFocusEvents, setAutoFocusEvents] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [notice, setNotice] = useState(null);
  const focusAttemptRef = useRef(0);
  const panelRef = useRef(null);
  const didFocusPanelRef = useRef(false);
  const chatTabRef = useRef(null);
  const eventsTabRef = useRef(null);
  // Optimistic user bubble while the turn runs; nothing is persisted yet.
  const [pendingQuestion, setPendingQuestion] = useState('');

  const focusHighlight = useCallback(
    async (range) => {
      const attempt = focusAttemptRef.current + 1;
      focusAttemptRef.current = attempt;
      if (subjectLabel === 'video') {
        setNotice({ tone: 'progress', message: 'Jumping to video evidence…' });
      }
      try {
        const result = onHighlight
          ? await onHighlight(range, { focus: true })
          : subjectLabel === 'video'
            ? { ok: false, message: 'Video jumping is not available in this view.' }
            : undefined;
        if (attempt !== focusAttemptRef.current || subjectLabel !== 'video') return result;
        setNotice(
          result?.message
            ? {
                tone: result.ok === false ? 'error' : result.tone || 'success',
                message: result.message,
              }
            : { tone: 'success', message: 'Jumped to video evidence.' },
        );
        return result;
      } catch (error) {
        if (attempt === focusAttemptRef.current && subjectLabel === 'video') {
          setNotice({
            tone: 'error',
            message: error?.message || 'Could not jump to this video evidence. Please try again.',
          });
        }
        return undefined;
      }
    },
    [onHighlight, subjectLabel],
  );

  const applyEvent = useCallback(
    (event, { focus = false } = {}) => {
      onClearHighlights?.();
      const range = eventRange(event);
      if (range) {
        if (focus) void focusHighlight(range);
        else onHighlight?.(range);
      }
    },
    [focusHighlight, onClearHighlights, onHighlight],
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
    clearSelection,
    deleteEvent,
    deleteChat,
    adoptPersistedTurn,
  } = useChatSessions({ recordKey, applyEvent });

  // Unmounting the panel (chat closed) must not leave a stale highlight
  // painted on the article behind it.
  const onClearHighlightsRef = useRef(onClearHighlights);
  useEffect(() => {
    onClearHighlightsRef.current = onClearHighlights;
  }, [onClearHighlights]);
  useEffect(() => {
    return () => {
      focusAttemptRef.current += 1;
      onClearHighlightsRef.current?.();
    };
  }, []);

  useEffect(() => {
    if (isLoadingHistory || didFocusPanelRef.current) return;
    const textarea = panelRef.current?.querySelector('textarea:not(:disabled)');
    if (!textarea) return;
    didFocusPanelRef.current = true;
    textarea.focus();
  }, [isLoadingHistory]);

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
    setNotice(null);
  }, [isLoading, startNewChat]);

  const handlePanelKeyDown = useCallback(
    (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (showHistory) {
        event.preventDefault();
        event.stopPropagation();
        setShowHistory(false);
        return;
      }
      if (selectedEventSeq !== null && (subjectLabel === 'article' || activeTab === 'events')) {
        event.preventDefault();
        event.stopPropagation();
        clearSelection();
        return;
      }
      const requestClose = onEscape || onClose;
      if (!requestClose) return;
      event.preventDefault();
      event.stopPropagation();
      if (input.trim() || isLoading) {
        setNotice({
          tone: 'warning',
          message: isLoading
            ? 'The assistant is still responding. Wait for it to finish before closing with Escape.'
            : 'Send or clear your draft before closing with Escape.',
        });
        return;
      }
      requestClose();
    },
    [
      activeTab,
      clearSelection,
      input,
      isLoading,
      onClose,
      onEscape,
      selectedEventSeq,
      showHistory,
      subjectLabel,
    ],
  );

  const handleDeleteChat = useCallback(
    (chatId) => {
      if (isLoading) return;
      void deleteChat(chatId);
    },
    [deleteChat, isLoading],
  );

  const handleTabKeyDown = useCallback((event) => {
    const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const nextTab =
      event.key === 'Home'
        ? 'chat'
        : event.key === 'End'
          ? 'events'
          : event.currentTarget === chatTabRef.current
            ? 'events'
            : 'chat';
    setActiveTab(nextTab);
    (nextTab === 'chat' ? chatTabRef.current : eventsTabRef.current)?.focus();
  }, []);

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
            if (autoFocusEvents) return focusHighlight(range);
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
    focusHighlight,
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
    <section
      ref={panelRef}
      className={`pagetollm-chat${headerActionsTarget === undefined ? '' : ' has-external-header-actions'}`}
      aria-label={`${subjectTitle} assistant`}
      aria-busy={isLoading || isLoadingHistory}
      onMouseDown={(event) => event.stopPropagation()}
      onKeyDown={handlePanelKeyDown}
    >
      {headerActionsTarget === undefined ? (
        <header className="pagetollm-chat-header">
          <div className="pagetollm-chat-actions">
            <button type="button" onClick={() => setShowHistory((value) => !value)}>
              History
            </button>
            <button type="button" onClick={handleNewChat} disabled={isLoading}>
              New
            </button>
          </div>
          {onClose ? (
            <button
              className="pagetollm-chat-close"
              type="button"
              onClick={onClose}
              aria-label="Close chat"
              title="Close chat"
            >
              ×
            </button>
          ) : null}
        </header>
      ) : headerActionsTarget ? (
        createPortal(
          <div className="pagetollm-chat-actions">
            <button type="button" onClick={() => setShowHistory((value) => !value)}>
              History
            </button>
            <button type="button" onClick={handleNewChat} disabled={isLoading}>
              New
            </button>
          </div>,
          headerActionsTarget,
        )
      ) : null}

      {showHistory ? (
        <ChatHistoryPanel
          chats={chats}
          activeChatId={activeChatId}
          onSelectChat={(chatId) => void handleSelectChat(chatId)}
          onDeleteChat={handleDeleteChat}
        />
      ) : null}

      <div className="pagetollm-chat-tabs">
        <div className="pagetollm-chat-tab-buttons" role="tablist" aria-label="Assistant views">
          <button
            ref={chatTabRef}
            type="button"
            role="tab"
            id={`${panelId}-chat-tab`}
            aria-controls={`${panelId}-chat-panel`}
            aria-selected={activeTab === 'chat'}
            className={activeTab === 'chat' ? 'is-active' : ''}
            onClick={() => setActiveTab('chat')}
            onKeyDown={handleTabKeyDown}
          >
            Chat
          </button>
          <button
            ref={eventsTabRef}
            type="button"
            role="tab"
            id={`${panelId}-events-tab`}
            aria-controls={`${panelId}-events-panel`}
            aria-selected={activeTab === 'events'}
            className={activeTab === 'events' ? 'is-active' : ''}
            onClick={() => setActiveTab('events')}
            onKeyDown={handleTabKeyDown}
          >
            Events <span>{events.length}</span>
          </button>
        </div>
        <label
          className="pagetollm-chat-events-live"
          title={
            subjectLabel === 'video'
              ? 'Automatically jump the video to new evidence'
              : 'Automatically scroll or zoom to new events'
          }
        >
          <input
            type="checkbox"
            aria-label={subjectLabel === 'video' ? 'Live video jumps' : 'Live event focus'}
            checked={autoFocusEvents}
            onChange={(event) => setAutoFocusEvents(event.target.checked)}
          />
          Live
        </label>
      </div>

      {activeTab === 'events' ? (
        <div
          id={`${panelId}-events-panel`}
          className="pagetollm-chat-tab-panel"
          role="tabpanel"
          aria-labelledby={`${panelId}-events-tab`}
        >
          <ChatEventsList
            events={events}
            selectedEventSeq={selectedEventSeq}
            onSelectEvent={selectEvent}
            onDeleteEvent={(event) => void deleteEvent(event)}
            subject={subjectLabel}
            getEventTimestamp={getEventTimestamp}
          />
        </div>
      ) : (
        <div
          id={`${panelId}-chat-panel`}
          className="pagetollm-chat-tab-panel"
          role="tabpanel"
          aria-labelledby={`${panelId}-chat-tab`}
        >
          <ChatMessageList
            messages={visibleMessages}
            isLoading={isLoading}
            isLoadingHistory={isLoadingHistory}
            emptyPrompt={`Ask a question about this ${subjectLabel}.`}
          />
          <ChatComposer
            value={input}
            onChange={setInput}
            onSend={() => void send()}
            disabled={isLoading || isLoadingHistory}
            placeholder={`Ask about this ${subjectLabel}…`}
          />
        </div>
      )}

      {notice ? (
        <div
          className={`pagetollm-chat-status is-${notice.tone}`}
          role={notice.tone === 'error' ? 'alert' : 'status'}
          aria-live={notice.tone === 'error' ? 'assertive' : 'polite'}
        >
          {notice.message}
        </div>
      ) : null}

      {error ? (
        <div className="pagetollm-chat-error" role="alert">
          {error}
        </div>
      ) : null}
    </section>
  );
}
