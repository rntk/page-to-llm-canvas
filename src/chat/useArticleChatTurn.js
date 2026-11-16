import { useCallback, useEffect, useRef, useState } from 'react';
import { MAX_TURN_EVENTS } from '../shared/runtime/contracts.js';
import { createTurnId } from './articleChat.js';
import { awaitWithAbort } from './turnCancellation.js';
import { scopeChatSentences } from './topicScope.js';

// Thrown by chat storage when an append targets a chat that no longer exists.
const CHAT_NOT_FOUND_MESSAGE = 'chat not found';

// Owns the lifetime of a turn, including its retry payload and storage commit.
export function useArticleChatTurn({
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
}) {
  const [isLoading, setIsLoading] = useState(false);
  const [pendingQuestion, setPendingQuestion] = useState('');
  const [retryTurn, setRetryTurn] = useState(null);
  // Tools called so far by the in-flight turn, shown live under "Thinking…".
  const [liveToolLog, setLiveToolLog] = useState([]);
  const mountedRef = useRef(true);
  const recordKeyRef = useRef(recordKey);
  const operationRef = useRef(null);
  const isCurrentOperation = useCallback(
    (operation) =>
      mountedRef.current &&
      operationRef.current === operation &&
      recordKeyRef.current === operation.recordKey,
    [],
  );
  // `restoreQuestion` is for deactivation (panel hidden/unmounted, new scope
  // request): the in-flight question returns to the composer and a finished-but-unsaved
  // answer stays retryable. Record switches and Stop never pass it.
  // Returns the restored question, or null.
  const invalidate = useCallback(
    (clearRetry = true, { restoreQuestion = false } = {}) => {
      const operation = operationRef.current;
      let restoredQuestion = null;
      operation?.controller.abort();
      operationRef.current = null;
      setIsLoading(false);
      setPendingQuestion('');
      setLiveToolLog([]);
      if (clearRetry) setRetryTurn(null);
      if (operation && restoreQuestion && !operation.state.persisted) {
        setInput(operation.question);
        restoredQuestion = operation.question;
        const { turnResult } = operation.state;
        if (turnResult && !clearRetry) {
          setRetryTurn({
            question: operation.question,
            turnId: operation.turnId,
            turnResult,
            recordKey: operation.recordKey,
            chatId: operation.chatId,
            persistenceChatId: operation.state.persistenceChatId,
            contentRevision: operation.contentRevision,
          });
        }
      }
      return restoredQuestion;
    },
    [setInput],
  );
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      invalidate(false, { restoreQuestion: true });
    };
  }, [invalidate]);
  useEffect(() => {
    if (recordKeyRef.current !== recordKey) {
      invalidate();
      setNotice(null);
    }
    recordKeyRef.current = recordKey;
  }, [recordKey, invalidate, setNotice]);

  const stopActiveTurn = useCallback(() => {
    const operation = operationRef.current;
    if (!operation || !isCurrentOperation(operation) || operation.controller.signal.aborted) return;
    // Answer complete, save pending: stopping would abort nothing and leave a stuck notice.
    if (operation.state.turnResult) return;
    operation.state.stopping = true;
    operation.controller.abort();
    setNotice({ tone: 'progress', message: 'Stopping response…' });
  }, [isCurrentOperation, setNotice]);

  // A Stop that lost the race to a completed answer must not leave its notice behind.
  const clearStoppingNotice = useCallback(
    (operation) => {
      if (!operation.state.stopping) return;
      setNotice((current) => (current?.tone === 'progress' ? null : current));
    },
    [setNotice],
  );

  const persist = useCallback(
    async (operation, question, turnResult) => {
      const append = (chatId) =>
        chatRepository.append(
          operation.recordKey,
          chatId,
          {
            turnId: operation.turnId,
            scope,
            messages: [
              { role: 'user', content: question },
              {
                role: 'assistant',
                content: turnResult.reply,
                ...(turnResult.toolLog?.length ? { toolLog: turnResult.toolLog } : {}),
              },
            ],
            // Redundant guard for injected runTurn implementations; the engine
            // enforces this limit before painting any highlight.
            events: turnResult.highlightRanges.slice(0, MAX_TURN_EVENTS).map((range) => ({
              eventType: 'highlight_span',
              data: range,
            })),
          },
          { expectedContentRevision: operation.contentRevision },
        );
      try {
        return await append(operation.state.persistenceChatId);
      } catch (err) {
        // The chat was deleted mid-turn: save the answer to a new chat (the same
        // turnId keeps the append idempotent).
        if (operation.state.persistenceChatId === null || err?.message !== CHAT_NOT_FOUND_MESSAGE) {
          throw err;
        }
        // Keep this target across retries; null lets storage find the replacement chat by turn ID.
        operation.state.persistenceChatId = null;
        return append(null);
      }
    },
    [chatRepository, scope],
  );

  const send = useCallback(async () => {
    const question = input.trim();
    if (!question || isLoading || isMutatingHistory || !recordKey || isScopeBlocked) return;
    const candidate = retryTurn;
    const retry =
      candidate?.recordKey === recordKey &&
      candidate?.chatId === (activeChatId ?? null) &&
      candidate?.contentRevision === contentRevision
        ? candidate
        : null;
    const turnId = retry?.question === question ? retry.turnId : createTurnId();
    const operation = Object.freeze({
      turnId,
      recordKey,
      contentRevision,
      chatId: activeChatId ?? null,
      question,
      controller: new AbortController(),
      // Mutable progress shared with stop/invalidate, which only see the frozen operation.
      state: {
        turnResult: undefined,
        stopping: false,
        persisted: false,
        persistenceChatId:
          retry?.question === question ? retry.persistenceChatId : (activeChatId ?? null),
      },
    });
    operationRef.current = operation;
    setInput('');
    setError('');
    setNotice(null);
    setIsLoading(true);
    setPendingQuestion(question);
    setLiveToolLog([]);
    setRetryTurn(null);
    let turnResult = retry?.question === question ? retry.turnResult : undefined;
    operation.state.turnResult = turnResult;
    try {
      try {
        // The provider's context window lives in the background worker, so read the
        // limits right before the turn instead of using the static fallback.
        if (!turnResult) {
          const limits = await awaitWithAbort(getChatLimits(), operation.controller.signal);
          if (!isCurrentOperation(operation)) return;
          // Late-bound sources resolve here so a failed read surfaces as a turn error.
          const turnSentences = resolveSentences
            ? scopeChatSentences(
                await awaitWithAbort(resolveSentences(), operation.controller.signal),
                topics,
                scope,
              )
            : scopedSentences;
          if (!isCurrentOperation(operation)) return;
          turnResult = await runTurn({
            article: {
              history: messages,
              sentences: turnSentences,
              highlightedRanges,
              ...(source ? { source } : {}),
            },
            ...(tools?.length ? { tools } : {}),
            question,
            limits,
            runtime: {
              turnId,
              signal: operation.controller.signal,
            },
            effects: {
              onHighlight: (range) => {
                if (!isCurrentOperation(operation)) return undefined;
                return onHighlight?.(range);
              },
              onToolCall: (entry) => {
                if (!isCurrentOperation(operation)) return;
                setLiveToolLog((current) => [...current, entry]);
              },
            },
          });
        }
        // Closing/unmounting invalidates the operation before it can write.
        if (!isCurrentOperation(operation)) return;
        // Visible to Stop/invalidate so they treat the answer as complete.
        operation.state.turnResult = turnResult;
        // Persists only user-visible content; the tool transcript may hold provider reasoning.
        const persisted = await persist(operation, question, turnResult);
        if (!isCurrentOperation(operation)) return;
        // Record was reanalyzed under this panel; storage refused the answer and
        // retrying cannot help until the panel is reopened.
        if (persisted?.stale) {
          // Writes are safe: isCurrentOperation() was checked with no await since.
          setRetryTurn(null);
          setPendingQuestion('');
          setInput(question);
          applyEvents(paintedEvents);
          setError(
            `This ${subjectLabel} was reanalyzed elsewhere, so the answer was not saved. Reopen it to chat about the new version.`,
          );
          return;
        }
        operation.state.persisted = true;
        adoptPersistedTurn(persisted, {
          expectedChatId: operation.chatId,
          turnId,
        });
        // Safe: isCurrentOperation() was checked above with no await since.
        setRetryTurn(null);
        setPendingQuestion('');
        clearStoppingNotice(operation);
      } catch (err) {
        if (!isCurrentOperation(operation)) return;
        // A runtime response can be lost after storage committed. For an
        // existing chat, reconcile by turnId before treating it as a failure.
        const reconciled = turnResult
          ? await reconcilePersistedTurn(operation.state.persistenceChatId, turnId)
          : false;
        if (reconciled && isCurrentOperation(operation)) {
          operation.state.persisted = true;
          // Same guard: no await since the check.
          setRetryTurn(null);
          setPendingQuestion('');
          clearStoppingNotice(operation);
          return;
        }
        if (!isCurrentOperation(operation)) return;
        // Same guard: no await since the check.
        setRetryTurn({
          question,
          turnId,
          turnResult,
          recordKey: operation.recordKey,
          chatId: operation.chatId,
          persistenceChatId: operation.state.persistenceChatId,
          contentRevision: operation.contentRevision,
        });
        setPendingQuestion('');
        setInput(question);
        applyEvents(paintedEvents);
        if (err?.name === 'AbortError') {
          setRetryTurn(null);
          setError('');
          setNotice({ tone: 'warning', message: 'Response stopped.' });
          return;
        }
        setError(
          turnResult
            ? `${err?.message || 'Failed to save response.'} The answer is unsaved. Send the same question again to retry saving it.`
            : err?.message || 'Failed to get a response.',
        );
        return;
      }
      // The turn is persisted; the refresh only updates sidebar titles/counts,
      // so a failure must not roll back or surface an error.
      try {
        await refreshChats();
      } catch {
        // Stale sidebar titles/counts are acceptable; the turn is persisted.
      }
    } finally {
      if (mountedRef.current && operationRef.current === operation) {
        operationRef.current = null;
        setPendingQuestion('');
        setLiveToolLog([]);
        setIsLoading(false);
        clearStoppingNotice(operation);
      }
    }
  }, [
    activeChatId,
    adoptPersistedTurn,
    applyEvents,
    clearStoppingNotice,
    persist,
    contentRevision,
    getChatLimits,
    highlightedRanges,
    input,
    isCurrentOperation,
    isLoading,
    isMutatingHistory,
    messages,
    isScopeBlocked,
    onHighlight,
    paintedEvents,
    reconcilePersistedTurn,
    recordKey,
    refreshChats,
    resolveSentences,
    retryTurn,
    runTurn,
    scope,
    scopedSentences,
    source,
    tools,
    topics,
    setError,
    setInput,
    setNotice,
    subjectLabel,
  ]);

  return {
    isLoading,
    pendingQuestion,
    liveToolLog,
    retryTurn,
    setRetryTurn,
    start: send,
    cancel: stopActiveTurn,
    invalidate,
  };
}
