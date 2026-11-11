import { useCallback, useEffect, useRef, useState } from 'react';
import { MAX_TURN_EVENTS } from '../shared/runtime/contracts.js';
import { createTurnId } from './articleChat.js';
import { scopeChatSentences } from './topicScope.js';

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
  const invalidate = useCallback((clearRetry = true) => {
    operationRef.current?.controller.abort();
    operationRef.current = null;
    setIsLoading(false);
    setPendingQuestion('');
    if (clearRetry) setRetryTurn(null);
  }, []);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      invalidate(false);
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
    operation.controller.abort();
    setNotice({ tone: 'progress', message: 'Stopping response…' });
  }, [isCurrentOperation, setNotice]);

  const persist = useCallback(
    (operation, question, turnResult) => {
      return chatRepository.append(
        operation.recordKey,
        operation.chatId,
        {
          turnId: operation.turnId,
          scope,
          messages: [
            { role: 'user', content: question },
            { role: 'assistant', content: turnResult.reply },
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
      controller: new AbortController(),
    });
    operationRef.current = operation;
    setInput('');
    setError('');
    setNotice(null);
    setIsLoading(true);
    setPendingQuestion(question);
    setRetryTurn(null);
    let turnResult = retry?.question === question ? retry.turnResult : undefined;
    try {
      try {
        // Run the whole turn first; onHighlight paints new evidence as it streams.
        // The content-script splits source text, but the active provider (and
        // its context window) live in the background worker. Read the resulting
        // budget immediately before the turn so small-window providers do not
        // receive the static 60k-character fallback.
        if (!turnResult) {
          const limits = await getChatLimits();
          if (!isCurrentOperation(operation)) return;
          // Late-bound sources (a live tab read on first send) resolve here, so
          // a failed read surfaces like any other turn error.
          const turnSentences = resolveSentences
            ? scopeChatSentences(await resolveSentences(), topics, scope)
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
            },
          });
        }
        // Closing/unmounting invalidates the operation before it can write.
        if (!isCurrentOperation(operation)) return;
        // Persist only replayable user-visible content. Tool transcripts are
        // transient implementation detail and may contain provider reasoning.
        const persisted = await persist(operation, question, turnResult);
        if (!isCurrentOperation(operation)) return;
        // The record was reanalyzed while this panel held the old source: the
        // answer belongs to content this record no longer has, so storage
        // refused it. Retrying cannot help until the panel is reopened.
        if (persisted?.stale) {
          // Unconditional writes gated by the isCurrentOperation() check above
          // with no intervening await (same rule as the success path below).
          setRetryTurn(null);
          setPendingQuestion('');
          setInput(question);
          applyEvents(paintedEvents);
          setError(
            `This ${subjectLabel} was reanalyzed elsewhere, so the answer was not saved. Reopen it to chat about the new version.`,
          );
          return;
        }
        adoptPersistedTurn(persisted, {
          expectedChatId: operation.chatId,
          turnId,
        });
        // Unconditional write gated by the isCurrentOperation() check immediately
        // above with no intervening await; a concurrent send() would have already
        // replaced operationRef.current, so no stale invocation reaches this line.
        setRetryTurn(null);
        setPendingQuestion('');
      } catch (err) {
        if (!isCurrentOperation(operation)) return;
        // A runtime response can be lost after storage committed. For an
        // existing chat, reconcile by turnId before treating it as a failure.
        const reconciled = turnResult
          ? await reconcilePersistedTurn(operation.chatId, turnId)
          : false;
        if (reconciled && isCurrentOperation(operation)) {
          // Same operation-identity guard as above, checked synchronously on this line.
          setRetryTurn(null);
          setPendingQuestion('');
          return;
        }
        if (!isCurrentOperation(operation)) return;
        // Same operation-identity guard, no intervening await since the check above.
        setRetryTurn({
          question,
          turnId,
          turnResult,
          recordKey: operation.recordKey,
          chatId: operation.chatId,
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
    retryTurn,
    setRetryTurn,
    start: send,
    cancel: stopActiveTurn,
    invalidate,
  };
}
