import { useCallback, useEffect, useRef, useState } from 'react';
import { MAX_TURN_EVENTS } from '../shared/runtime/contracts.js';
import { createTurnId } from './articleChat.js';
import { awaitWithAbort } from './turnCancellation.js';
import { scopeChatSentences } from './topicScope.js';

// Thrown by chat storage when an append targets a chat that no longer exists.
const CHAT_NOT_FOUND_MESSAGE = 'chat not found';

// One turn's identity plus its progress, exposed only through lifecycle operations.
// `retry` resumes a previous attempt when it asked the same question: the turn ID,
// any finished answer, and the save target carry over so the append stays idempotent.
function createTurnOperation({ question, recordKey, contentRevision, chatId, retry }) {
  const resumed = retry?.question === question ? retry : null;
  const controller = new AbortController();
  const turnId = resumed ? resumed.turnId : createTurnId();
  let turnResult = resumed?.turnResult;
  let saveTarget = resumed ? resumed.persistenceChatId : chatId;
  let stopRequested = false;
  let persisted = false;
  return Object.freeze({
    turnId,
    recordKey,
    contentRevision,
    chatId,
    question,
    signal: controller.signal,
    get turnResult() {
      return turnResult;
    },
    get saveTarget() {
      return saveTarget;
    },
    get stopRequested() {
      return stopRequested;
    },
    get persisted() {
      return persisted;
    },
    // User-initiated Stop. Refused once aborted or once the answer is complete
    // (only the save is pending; aborting would cancel nothing). Returns whether it took effect.
    requestStop() {
      if (controller.signal.aborted || turnResult) return false;
      stopRequested = true;
      controller.abort();
      return true;
    },
    // Panel deactivation, record switch, or supersession: aborts without counting as Stop.
    deactivate() {
      controller.abort();
    },
    recordResult(result) {
      turnResult = result;
    },
    // The original chat was deleted: target a new chat (null lets storage find the
    // replacement by turn ID). Returns false if already targeting a new chat.
    retargetToNewChat() {
      if (saveTarget === null) return false;
      saveTarget = null;
      return true;
    },
    markPersisted() {
      persisted = true;
    },
    retryPayload() {
      return {
        question,
        turnId,
        turnResult,
        recordKey,
        chatId,
        persistenceChatId: saveTarget,
        contentRevision,
      };
    },
  });
}

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
      operation?.deactivate();
      operationRef.current = null;
      setIsLoading(false);
      setPendingQuestion('');
      setLiveToolLog([]);
      if (clearRetry) setRetryTurn(null);
      if (operation && restoreQuestion && !operation.persisted) {
        setInput(operation.question);
        restoredQuestion = operation.question;
        if (operation.turnResult && !clearRetry) setRetryTurn(operation.retryPayload());
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
    if (!operation || !isCurrentOperation(operation)) return;
    // Refused when the answer is complete: stopping would abort nothing and leave a stuck notice.
    if (!operation.requestStop()) return;
    setNotice({ tone: 'progress', message: 'Stopping response…' });
  }, [isCurrentOperation, setNotice]);

  // A Stop that lost the race to a completed answer must not leave its notice behind.
  const clearStoppingNotice = useCallback(
    (operation) => {
      if (!operation.stopRequested) return;
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
        return await append(operation.saveTarget);
      } catch (err) {
        // The chat was deleted mid-turn: save the answer to a new chat (the same
        // turnId keeps the append idempotent). The new target carries into retries.
        if (err?.message !== CHAT_NOT_FOUND_MESSAGE || !operation.retargetToNewChat()) throw err;
        return append(operation.saveTarget);
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
    const operation = createTurnOperation({
      question,
      recordKey,
      contentRevision,
      chatId: activeChatId ?? null,
      retry,
    });
    const { turnId, signal } = operation;
    operationRef.current = operation;
    setInput('');
    setError('');
    setNotice(null);
    setIsLoading(true);
    setPendingQuestion(question);
    setLiveToolLog([]);
    setRetryTurn(null);
    let turnResult = operation.turnResult;
    try {
      try {
        // The provider's context window lives in the background worker, so read the
        // limits right before the turn instead of using the static fallback.
        if (!turnResult) {
          const limits = await awaitWithAbort(getChatLimits(), signal);
          if (!isCurrentOperation(operation)) return;
          // Late-bound sources resolve here so a failed read surfaces as a turn error.
          const turnSentences = resolveSentences
            ? scopeChatSentences(
                await awaitWithAbort(resolveSentences(), signal),
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
              signal,
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
        operation.recordResult(turnResult);
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
        operation.markPersisted();
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
          ? await reconcilePersistedTurn(operation.saveTarget, turnId)
          : false;
        if (reconciled && isCurrentOperation(operation)) {
          operation.markPersisted();
          // Same guard: no await since the check.
          setRetryTurn(null);
          setPendingQuestion('');
          clearStoppingNotice(operation);
          return;
        }
        if (!isCurrentOperation(operation)) return;
        // Same guard: no await since the check.
        setRetryTurn(operation.retryPayload());
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
