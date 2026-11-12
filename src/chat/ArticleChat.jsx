import React, { Activity, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { runArticleChatTurn } from './articleChat.js';
import { useArticleChatTurn } from './useArticleChatTurn.js';
import { browserChatRepository, getArticleChatLimits } from './chatApi.js';
import { eventRange, useChatSessions } from './useChatSessions.js';
import ChatComposer from './ChatComposer.jsx';
import ChatEventsList from './ChatEventsList.jsx';
import ChatHistoryPanel from './ChatHistoryPanel.jsx';
import ChatMessageList from './ChatMessageList.jsx';
import { buildTopicSentenceIndex, getTopicPaths } from '../domain/topicDomain.js';
import { scopeChatSentences } from './topicScope.js';
import TopicScopeDialog from './TopicScopeDialog.jsx';

const EMPTY_SENTENCES = [];
const EMPTY_TOPICS = [];

function ChatHeaderActions({ disabled, onShowHistory, onNewChat }) {
  return (
    <div className="pagetollm-chat-actions">
      <button type="button" onClick={onShowHistory} disabled={disabled}>
        History
      </button>
      <button type="button" onClick={onNewChat} disabled={disabled}>
        New
      </button>
    </div>
  );
}

/**
 * Article chat panel. A turn streams highlights, then commits once with a stable
 * turn id so a lost storage acknowledgement can be retried safely. Storage and
 * turn execution use injectable ports.
 *
 * @param {object} props
 * @param {string} props.recordKey
 * @param {string[]} [props.sentences] Omit when `resolveSentences` or a project
 *   `source` supplies the text.
 * @param {object[]} [props.topics] Topics and their document sentence numbers.
 * @param {{paths: string[]}} [props.scopeRequest] Starts a fresh scoped chat.
 * @param {Function} [props.onScopeRequestHandled] Consumes an external scope request.
 * @param {string} [props.contentRevision] Rejects persistence after reanalysis.
 * @param {function(object): void} [props.onHighlight]
 * @param {function(): void} [props.onClearHighlights]
 * @param {function(): void} [props.onClose]
 * @param {function(): void} [props.onEscape]
 * @param {?HTMLElement} [props.headerActionsTarget]
 * @param {'article' | 'video'} [props.subject]
 * @param {function(object): ?number} [props.getEventTimestamp]
 * @param {{list: Function, get: Function, append: Function, remove: Function}} [props.chatRepository]
 * @param {function(object): Promise<object>} [props.runTurn]
 * @param {function(): Promise<{maxChunkChars: number, maxHistoryChars: number}>} [props.getChatLimits]
 * @param {function(): Promise<string[]>} [props.resolveSentences] Supplies the
 *   source at send time instead of `sentences` (e.g. text read from a live tab).
 * @param {string} [props.emptyPrompt] Overrides the empty-chat hint.
 * @param {{kind: 'excerpt', pageTitle?: string, pageUrl?: string}|{kind: 'sections', topic?: string, pages: object[]}|{kind: 'project', preamble: string}} [props.source]
 *   Frames the sentences for the model (an excerpt of a longer page). A project
 *   source chats over `tools` alone: omit `sentences` and `topics`.
 * @param {object[]} [props.tools] Turn tools besides highlight_span (see runArticleChatTurn).
 *   Keep it referentially stable.
 */
function ArticleChat({
  recordKey,
  sentences = EMPTY_SENTENCES,
  contentRevision,
  topics = EMPTY_TOPICS,
  scopeRequest,
  onScopeRequestHandled,
  onHighlight,
  onClearHighlights,
  onClose,
  onEscape,
  headerActionsTarget,
  subject = 'article',
  getEventTimestamp,
  chatRepository = browserChatRepository,
  runTurn = runArticleChatTurn,
  getChatLimits = getArticleChatLimits,
  resolveSentences,
  emptyPrompt,
  source,
  tools,
}) {
  const panelId = useId();
  const [showScopeDialog, setShowScopeDialog] = useState(false);
  const appliedScopeRequest = useRef(null);
  const topicPaths = useMemo(() => getTopicPaths(topics), [topics]);
  const topicSentenceIndex = useMemo(() => buildTopicSentenceIndex(topics), [topics]);
  const isProjectSource = source?.kind === 'project';
  const subjectLabel = subject === 'video' ? 'video' : isProjectSource ? 'project' : 'article';
  const subjectTitle = `${subjectLabel[0].toUpperCase()}${subjectLabel.slice(1)}`;
  const [input, setInput] = useState('');
  const [activeTab, setActiveTab] = useState('chat');
  const [showHistory, setShowHistory] = useState(false);
  const [notice, setNotice] = useState(null);
  const mountedRef = useRef(true);
  const focusAttemptRef = useRef(0);
  const panelRef = useRef(null);
  const didFocusPanelRef = useRef(false);
  const chatTabRef = useRef(null);
  const eventsTabRef = useRef(null);

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
  } = useChatSessions({ recordKey, applyEvents, chatRepository });

  const missingScopePaths = useMemo(
    () => scope.filter((path) => !topicPaths.includes(path)),
    [scope, topicPaths],
  );
  // The topics still exist but none of them covers any text, so a turn would
  // send the model an all-blank document.
  const isScopeEmpty = useMemo(
    () =>
      scope.length > 0 &&
      missingScopePaths.length === 0 &&
      scope.every((path) => !topicSentenceIndex.get(path)?.size),
    [scope, missingScopePaths, topicSentenceIndex],
  );
  const isScopeBlocked = missingScopePaths.length > 0 || isScopeEmpty;

  const scopedSentences = useMemo(
    () => scopeChatSentences(sentences, topics, scope),
    [sentences, topics, scope],
  );

  const highlightedRanges = useMemo(
    () => paintedEvents.map(eventRange).filter(Boolean),
    [paintedEvents],
  );
  const {
    isLoading,
    pendingQuestion,
    retryTurn,
    setRetryTurn,
    start: send,
    cancel: stopActiveTurn,
    invalidate,
  } = useArticleChatTurn({
    recordKey,
    contentRevision,
    activeChatId,
    input,
    setInput,
    setError,
    setNotice,
    isMutatingHistory,
    isScopeBlocked,
    getChatLimits,
    resolveSentences,
    topics,
    scope,
    scopedSentences,
    runTurn,
    messages,
    highlightedRanges,
    source,
    tools,
    onHighlight,
    chatRepository,
    paintedEvents,
    applyEvents,
    adoptPersistedTurn,
    reconcilePersistedTurn,
    refreshChats,
    subjectLabel,
  });

  useEffect(() => {
    if (!scopeRequest || appliedScopeRequest.current === scopeRequest) return;
    appliedScopeRequest.current = scopeRequest;
    // A question still in flight returns to the composer instead of vanishing
    // with the chat it was asked in; any finished answer is dropped with that chat.
    setInput(invalidate(true, { restoreQuestion: true }) ?? '');
    setShowHistory(false);
    setActiveTab('chat');
    startNewChat(scopeRequest.paths);
    void refreshChats().catch(() => {});
    onScopeRequestHandled?.();
  }, [scopeRequest, startNewChat, refreshChats, onScopeRequestHandled, invalidate]);

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
      focusAttemptRef.current += 1;
      onClearHighlightsRef.current?.();
      setNotice(null);
    };
  }, []);

  useEffect(() => {
    if (isLoadingHistory || didFocusPanelRef.current) return;
    const textarea = panelRef.current?.querySelector('textarea:not(:disabled)');
    if (!textarea) return;
    didFocusPanelRef.current = true;
    textarea.focus();
  }, [isLoadingHistory]);

  const visibleMessages = useMemo(() => {
    const visible = messages.filter((message) => !message.hidden);
    if (
      retryTurn?.turnResult &&
      retryTurn.recordKey === recordKey &&
      retryTurn.chatId === (activeChatId ?? null) &&
      retryTurn.contentRevision === contentRevision
    ) {
      visible.push(
        { role: 'user', content: retryTurn.question },
        { role: 'assistant', content: retryTurn.turnResult.reply },
      );
    }
    return pendingQuestion ? [...visible, { role: 'user', content: pendingQuestion }] : visible;
  }, [messages, pendingQuestion, retryTurn, recordKey, activeChatId, contentRevision]);

  const handleSelectChat = useCallback(
    async (chatId) => {
      if (isLoading || isMutatingHistory) return;
      if (await loadChat(chatId)) setShowHistory(false);
    },
    [isLoading, isMutatingHistory, loadChat],
  );

  const handleNewChat = useCallback(
    (nextScope = []) => {
      if (isLoading || isMutatingHistory) return;
      startNewChat(nextScope);
      setRetryTurn(null);
      setInput('');
      setShowHistory(false);
      setActiveTab('chat');
      setNotice(null);
    },
    [isLoading, isMutatingHistory, startNewChat, setRetryTurn],
  );

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

  const handleInputChange = useCallback(
    (value) => {
      if (retryTurn && retryTurn.question !== value.trim()) {
        setRetryTurn(null);
        setError('');
      }
      setInput(value);
    },
    [retryTurn, setError, setRetryTurn],
  );

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
          <ChatHeaderActions
            disabled={isLoading || isMutatingHistory}
            onShowHistory={() => setShowHistory((value) => !value)}
            onNewChat={() => handleNewChat()}
          />
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
          <ChatHeaderActions
            disabled={isLoading || isMutatingHistory}
            onShowHistory={() => setShowHistory((value) => !value)}
            onNewChat={() => handleNewChat()}
          />,
          headerActionsTarget,
        )
      ) : null}

      {/* A project chat has no document scope to show or choose. */}
      {isProjectSource && !scope.length ? null : (
        <div className="pagetollm-chat-scope">
          <span>{scope.length ? `Scoped chat: ${scope.join(', ')}` : 'Whole document'}</span>
          {/* A source without topics has nothing to choose, unless a saved scope
            must be cleared before the chat can send again. */}
          {topicPaths.length > 0 || scope.length > 0 ? (
            <button
              type="button"
              disabled={isLoading || isLoadingHistory || isMutatingHistory}
              onClick={() => setShowScopeDialog(true)}
            >
              Choose topics
            </button>
          ) : null}
        </div>
      )}
      {missingScopePaths.length > 0 && (
        <div className="pagetollm-chat-error" role="alert">
          Some selected topics no longer exist: {missingScopePaths.join(', ')}. Choose topics to
          start a new chat before sending another message.
        </div>
      )}
      {isScopeEmpty && (
        <div className="pagetollm-chat-error" role="alert">
          The selected topics contain no text. Choose topics to start a new chat before sending
          another message.
        </div>
      )}
      {showScopeDialog && (
        <TopicScopeDialog
          paths={topicPaths}
          scope={scope.filter((path) => topicPaths.includes(path))}
          onClose={() => setShowScopeDialog(false)}
          onApply={(paths) => {
            // A blocked chat can never send again, so Apply must always leave it.
            if (
              isScopeBlocked ||
              JSON.stringify([...paths].sort()) !== JSON.stringify([...scope].sort())
            ) {
              handleNewChat(paths);
            }
            setShowScopeDialog(false);
          }}
        />
      )}

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
      </div>

      <Activity mode={activeTab === 'events' ? 'visible' : 'hidden'}>
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
      </Activity>
      <Activity mode={activeTab === 'events' ? 'hidden' : 'visible'}>
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
            emptyPrompt={emptyPrompt || `Ask a question about this ${subjectLabel}.`}
          />
          <ChatComposer
            value={input}
            onChange={handleInputChange}
            onSend={() => void send()}
            onStop={stopActiveTurn}
            isLoading={isLoading}
            disabled={isLoading || isLoadingHistory || isMutatingHistory || isScopeBlocked}
            placeholder={`Ask about this ${subjectLabel}…`}
          />
        </div>
      </Activity>

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

// Chat lives beside the canvas's own render-heavy transform state (pan/zoom
// mint new scale/translate on every frame while the panel is open); without
// this, every canvas re-render would also reconcile the whole chat subtree.
// Props are kept referentially stable by callers for this to hold.
export default React.memo(ArticleChat);
