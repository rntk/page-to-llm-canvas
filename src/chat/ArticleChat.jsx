import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { runArticleChatTurn } from './articleChat.js';
import { persistChatTurn } from './chatApi.js';
import { eventRange, useChatSessions } from './useChatSessions.js';
import ChatComposer from './ChatComposer.jsx';
import ChatEventsList from './ChatEventsList.jsx';
import ChatHistoryPanel from './ChatHistoryPanel.jsx';
import ChatMessageList from './ChatMessageList.jsx';

function createTurnId() {
  return (
    globalThis.crypto?.randomUUID?.() ||
    `turn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`
  );
}

/**
 * Article chat panel: composes the persisted-session hook with the
 * presentational pieces and owns the send path. One LLM turn runs entirely
 * in memory (highlights are live-painted as they stream in) and is then
 * committed with one idempotent persistChatTurn call. A stable turn id makes
 * retrying safe when the storage commit succeeded but its acknowledgement was
 * lost.
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
  const mountedRef = useRef(true);
  const recordKeyRef = useRef(recordKey);
  const operationRef = useRef(null);
  const retryTurnRef = useRef(null);
  const focusAttemptRef = useRef(0);
  const panelRef = useRef(null);
  const didFocusPanelRef = useRef(false);
  const chatTabRef = useRef(null);
  const eventsTabRef = useRef(null);
  // Optimistic user bubble while the turn runs; nothing is persisted yet.
  const [pendingQuestion, setPendingQuestion] = useState('');

  const isCurrentOperation = useCallback(
    (operation) =>
      mountedRef.current &&
      operationRef.current === operation &&
      recordKeyRef.current === operation.recordKey,
    [],
  );

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
        if (
          !mountedRef.current ||
          attempt !== focusAttemptRef.current ||
          subjectLabel !== 'video'
        ) {
          return result;
        }
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
        if (mountedRef.current && attempt === focusAttemptRef.current && subjectLabel === 'video') {
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

  const applyEvents = useCallback(
    (nextEvents, { focusEvent = null } = {}) => {
      onClearHighlights?.();
      for (const event of nextEvents) {
        if (event === focusEvent) continue;
        const range = eventRange(event);
        if (range) onHighlight?.(range);
      }
      const focusRange = eventRange(focusEvent);
      if (focusRange) void focusHighlight(focusRange);
    },
    [focusHighlight, onClearHighlights, onHighlight],
  );

  const {
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
  } = useChatSessions({ recordKey, applyEvents });

  // Unmounting the panel (chat closed) must not leave a stale highlight
  // painted on the article behind it.
  const onClearHighlightsRef = useRef(onClearHighlights);
  useEffect(() => {
    onClearHighlightsRef.current = onClearHighlights;
  }, [onClearHighlights]);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      operationRef.current?.controller.abort();
      operationRef.current = null;
      focusAttemptRef.current += 1;
      onClearHighlightsRef.current?.();
    };
  }, []);

  useEffect(() => {
    if (recordKeyRef.current !== recordKey) {
      operationRef.current?.controller.abort();
      operationRef.current = null;
      setPendingQuestion('');
      setIsLoading(false);
      setNotice(null);
    }
    recordKeyRef.current = recordKey;
    retryTurnRef.current = null;
  }, [recordKey]);

  useEffect(() => {
    if (isLoadingHistory || didFocusPanelRef.current) return;
    const textarea = panelRef.current?.querySelector('textarea:not(:disabled)');
    if (!textarea) return;
    didFocusPanelRef.current = true;
    textarea.focus();
  }, [isLoadingHistory]);

  // Only currently painted evidence constrains overlap in the next turn.
  // Historical events remain available in the Events tab without being
  // misrepresented to the model as visible on the page.
  const highlightedRanges = useMemo(
    () => paintedEvents.map(eventRange).filter(Boolean),
    [paintedEvents],
  );

  const visibleMessages = useMemo(() => {
    const visible = messages.filter((message) => !message.hidden);
    return pendingQuestion ? [...visible, { role: 'user', content: pendingQuestion }] : visible;
  }, [messages, pendingQuestion]);

  const handleSelectChat = useCallback(
    async (chatId) => {
      if (isLoading || isMutatingHistory) return;
      if (await loadChat(chatId)) setShowHistory(false);
    },
    [isLoading, isMutatingHistory, loadChat],
  );

  const handleNewChat = useCallback(() => {
    if (isLoading || isMutatingHistory) return;
    startNewChat();
    setInput('');
    setShowHistory(false);
    setActiveTab('chat');
    setNotice(null);
  }, [isLoading, isMutatingHistory, startNewChat]);

  const warnActiveTurn = useCallback(() => {
    setNotice({
      tone: 'warning',
      message: 'The assistant is still responding. Wait for it to finish before changing chats.',
    });
  }, []);

  const handleClose = useCallback(() => {
    if (isLoading || isMutatingHistory) {
      warnActiveTurn();
      return;
    }
    onClose?.();
  }, [isLoading, isMutatingHistory, onClose, warnActiveTurn]);

  const handlePanelKeyDown = useCallback(
    (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (showHistory) {
        event.preventDefault();
        event.stopPropagation();
        setShowHistory(false);
        return;
      }
      if (isLoading || isMutatingHistory) {
        event.preventDefault();
        event.stopPropagation();
        warnActiveTurn();
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
      if (input.trim()) {
        setNotice({
          tone: 'warning',
          message: 'Send or clear your draft before closing with Escape.',
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
      isMutatingHistory,
      onClose,
      onEscape,
      selectedEventSeq,
      showHistory,
      subjectLabel,
      warnActiveTurn,
    ],
  );

  const handleDeleteChat = useCallback(
    (chatId) => {
      if (isLoading || isLoadingHistory || isMutatingHistory) return;
      void deleteChat(chatId);
    },
    [deleteChat, isLoading, isLoadingHistory, isMutatingHistory],
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

  const stopActiveTurn = useCallback(() => {
    const operation = operationRef.current;
    if (!operation || !isCurrentOperation(operation) || operation.controller.signal.aborted) return;
    operation.controller.abort();
    setNotice({ tone: 'progress', message: 'Stopping response…' });
  }, [isCurrentOperation]);

  const send = useCallback(async () => {
    const question = input.trim();
    if (!question || isLoading || isMutatingHistory || !recordKey) return;
    const retry = retryTurnRef.current;
    const turnId = retry?.question === question ? retry.turnId : createTurnId();
    const operation = Object.freeze({
      turnId,
      recordKey,
      chatId: activeChatId ?? null,
      controller: new AbortController(),
    });
    operationRef.current = operation;
    setInput('');
    setError('');
    setNotice(null);
    setIsLoading(true);
    setPendingQuestion(question);
    let turnResult;
    try {
      try {
        // Run the whole turn first; onHighlight only live-paints the article.
        turnResult = await runArticleChatTurn({
          history: messages,
          question,
          sentences,
          turnId,
          signal: operation.controller.signal,
          highlightedRanges,
          onHighlight: (range) => {
            if (!isCurrentOperation(operation)) return undefined;
            if (autoFocusEvents) return focusHighlight(range);
            return onHighlight?.(range);
          },
        });
        // Closing/unmounting invalidates the operation before it can write.
        if (!isCurrentOperation(operation)) return;
        // Persist only replayable user-visible content. Tool transcripts are
        // transient implementation detail and may contain provider reasoning.
        const persisted = await persistChatTurn(operation.recordKey, operation.chatId, {
          turnId,
          messages: [
            { role: 'user', content: question },
            { role: 'assistant', content: turnResult.reply },
          ],
          events: turnResult.highlightRanges.map((range) => ({
            eventType: 'highlight_span',
            data: range,
          })),
        });
        if (!isCurrentOperation(operation)) return;
        adoptPersistedTurn(persisted, {
          expectedChatId: operation.chatId,
          turnId,
        });
        retryTurnRef.current = null;
        setPendingQuestion('');
      } catch (err) {
        if (!isCurrentOperation(operation)) return;
        // A runtime response can be lost after storage committed. For an
        // existing chat, reconcile by turnId before treating it as a failure.
        const reconciled = turnResult
          ? await reconcilePersistedTurn(operation.chatId, turnId)
          : false;
        if (reconciled && isCurrentOperation(operation)) {
          retryTurnRef.current = null;
          setPendingQuestion('');
          return;
        }
        if (!isCurrentOperation(operation)) return;
        retryTurnRef.current = { question, turnId };
        setPendingQuestion('');
        setInput(question);
        applyEvents(paintedEvents);
        if (err?.name === 'AbortError') {
          retryTurnRef.current = null;
          setError('');
          setNotice({ tone: 'warning', message: 'Response stopped.' });
          return;
        }
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
      if (mountedRef.current && operationRef.current === operation) {
        operationRef.current = null;
        setPendingQuestion('');
        setIsLoading(false);
      }
    }
  }, [
    activeChatId,
    adoptPersistedTurn,
    applyEvents,
    autoFocusEvents,
    focusHighlight,
    highlightedRanges,
    input,
    isCurrentOperation,
    isLoading,
    isMutatingHistory,
    messages,
    onHighlight,
    paintedEvents,
    reconcilePersistedTurn,
    recordKey,
    refreshChats,
    sentences,
    setError,
  ]);

  const handleInputChange = useCallback((value) => {
    if (retryTurnRef.current?.question !== value.trim()) retryTurnRef.current = null;
    setInput(value);
  }, []);

  return (
    <section
      ref={panelRef}
      className={`pagetollm-chat${headerActionsTarget === undefined ? '' : ' has-external-header-actions'}`}
      aria-label={`${subjectTitle} assistant`}
      aria-busy={isLoading || isLoadingHistory || isMutatingHistory}
      onMouseDown={(event) => event.stopPropagation()}
      onKeyDown={handlePanelKeyDown}
    >
      {headerActionsTarget === undefined ? (
        <header className="pagetollm-chat-header">
          <div className="pagetollm-chat-actions">
            <button
              type="button"
              onClick={() => setShowHistory((value) => !value)}
              disabled={isLoading || isMutatingHistory}
            >
              History
            </button>
            <button type="button" onClick={handleNewChat} disabled={isLoading || isMutatingHistory}>
              New
            </button>
          </div>
          {onClose ? (
            <button
              className="pagetollm-chat-close"
              type="button"
              onClick={handleClose}
              disabled={isLoading || isMutatingHistory}
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
            <button
              type="button"
              onClick={() => setShowHistory((value) => !value)}
              disabled={isLoading || isMutatingHistory}
            >
              History
            </button>
            <button type="button" onClick={handleNewChat} disabled={isLoading || isMutatingHistory}>
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
          disabled={isLoading || isMutatingHistory}
          deleteDisabled={isLoading || isLoadingHistory || isMutatingHistory}
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
            onSelectEvent={(event) => {
              if (!isLoading && !isLoadingHistory && !isMutatingHistory) selectEvent(event);
            }}
            disabled={isLoading || isLoadingHistory || isMutatingHistory}
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
            onChange={handleInputChange}
            onSend={() => void send()}
            onStop={stopActiveTurn}
            isLoading={isLoading}
            disabled={isLoading || isLoadingHistory || isMutatingHistory}
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
