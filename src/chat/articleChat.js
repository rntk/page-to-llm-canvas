import { MAX_TURN_EVENTS } from '../shared/runtime/contracts.js';
import { MSG } from '../shared/runtime/messages.js';
import { CHAT_TOOL_OUTCOMES, LLM_TASK_TYPES } from '../shared/runtime/telemetry.js';
import { sendRuntimeMessage } from '../utils/runtimeMessages.js';
import { createChatLogger } from './chatLogger.js';
import {
  ARTICLE_CHAT_SYSTEM_PROMPT,
  HIGHLIGHT_BUDGET_EXHAUSTED_PROMPT,
  buildChunkDataMessage,
  buildQuestionDataMessage,
} from './articleChatPrompts.js';
import { ARTICLE_CHAT_CHUNK_MAX_CHARS, chunkNumberedArticle } from './articleChunking.js';
import { CHAT_HISTORY_MAX_CHARS, compactConversationHistory } from './conversationHistory.js';
import { HIGHLIGHT_SPAN_TOOL, rangesOverlap, validateHighlightArgs } from './highlightTool.js';
import {
  SYNTHESIS_GROUP_MIN_SIZE,
  buildSynthesisMessages,
  groupSynthesisReplies,
  minimumSynthesisChars,
} from './articleSynthesis.js';
import {
  abortReason,
  awaitWithAbort,
  createTurnId,
  postCancelChatTurn,
  throwIfAborted,
} from './turnCancellation.js';

// The turn is the single entry point for chatting about an article; the
// prompt, chunking, history, tool and synthesis modules above are re-exported
// so existing callers keep one import site.
export { chunkNumberedArticle } from './articleChunking.js';
export { rangesOverlap } from './highlightTool.js';
export { createTurnId } from './turnCancellation.js';

/**
 * Default transport for one tool-call outcome metric. Fire-and-forget: the
 * turn must never fail or stall because diagnostics could not be recorded, and
 * `chrome.runtime` may be absent (tests, non-extension contexts).
 * @param {object} sample Metric payload.
 */
function postToolMetric(sample) {
  try {
    void sendRuntimeMessage({ type: MSG.recordChatToolMetric, ...sample }).catch(() => {});
  } catch (_) {
    /* chrome.runtime unavailable — drop the metric silently. */
  }
}

// Long articles may require many distinct highlight passes before the model can
// compose its answer. Keep a finite guard against runaway tool loops, while
// allowing enough rounds for large content.
const MAX_TOOL_ROUNDS = 50;
// A floor, not a ceiling: a small context window splits an article into many
// chunks, and each chunk needs its own requests. The effective per-turn limit
// is derived from the chunk count (see runArticleChatTurn) and never drops
// below this, so short articles keep the established budget.
const MIN_TURN_LLM_REQUESTS = 50;
const ARTICLE_CHAT_CHUNK_CONCURRENCY = 3;
// A source chunk smaller than this cannot carry enough article to answer from.
const MIN_SOURCE_CHUNK_CHARS = 256;
const QUESTION_TOO_LONG_MESSAGE =
  'This question is too long for the active provider\'s context window. Shorten it, or raise "Context window (tokens)" in Options > LLM Providers.';
const DEFAULT_REQUESTS_PER_CHUNK = 3;

/**
 * @typedef {Object} ArticleChatTurnOptions
 * @property {object} article
 * @property {object[]} [article.history]
 * @property {string[]} [article.sentences]
 * @property {object[]} [article.highlightedRanges]
 * @property {string} question
 * @property {object} [limits]
 * @property {number} [limits.maxChunkChars]
 * @property {number} [limits.maxHistoryChars]
 * @property {number} [limits.maxToolRounds]
 * @property {number} [limits.maxLlmRequests]
 * @property {number} [limits.chunkConcurrency]
 * @property {object} [effects]
 * @property {function(object): (void|Promise<void>)} [effects.onHighlight]
 * @property {object} [dependencies]
 * @property {Function} [dependencies.send]
 * @property {Function} [dependencies.cancelTurn]
 * @property {Function} [dependencies.recordToolMetric]
 * @property {object} [runtime]
 * @property {string} [runtime.turnId]
 * @property {AbortSignal} [runtime.signal]
 */

/**
 * Converts the public grouped API into the internal turn representation.
 *
 * @param {ArticleChatTurnOptions} options
 */
function normalizeArticleChatTurnOptions(options = {}) {
  const article = options.article || {};
  const limits = options.limits || {};
  const effects = options.effects || {};
  const dependencies = options.dependencies || {};
  const runtime = options.runtime || {};

  return {
    history: article.history,
    question: options.question,
    sentences: article.sentences,
    onHighlight: effects.onHighlight,
    highlightedRanges: article.highlightedRanges ?? [],
    maxChunkChars: limits.maxChunkChars ?? ARTICLE_CHAT_CHUNK_MAX_CHARS,
    maxToolRounds: limits.maxToolRounds ?? MAX_TOOL_ROUNDS,
    maxHistoryChars: limits.maxHistoryChars ?? CHAT_HISTORY_MAX_CHARS,
    maxLlmRequests: limits.maxLlmRequests,
    chunkConcurrency: limits.chunkConcurrency ?? ARTICLE_CHAT_CHUNK_CONCURRENCY,
    turnId: runtime.turnId ?? createTurnId(),
    signal: runtime.signal,
    send: dependencies.send ?? sendRuntimeMessage,
    cancelTurn: dependencies.cancelTurn ?? postCancelChatTurn,
    recordToolMetric: dependencies.recordToolMetric ?? postToolMetric,
  };
}

/**
 * Run the assistant/tool loop against one bounded source chunk. It shares the
 * turn-wide range lists and transcript with sibling chunks but has its own
 * cacheable source prefix.
 * @param {object} input Chunk-loop state and dependencies.
 */
async function runArticleChatChunk({
  chunk,
  history,
  maxHistoryChars,
  question,
  sentenceCount,
  ranges,
  newRanges,
  eventBudget,
  transcriptMessages,
  onHighlight,
  maxToolRounds,
  send,
  signal,
  turnId,
  log,
  recordToolMetric,
}) {
  const messages = [
    { role: 'system', content: ARTICLE_CHAT_SYSTEM_PROMPT },
    { role: 'user', content: buildChunkDataMessage(chunk) },
    ...compactConversationHistory(history, maxHistoryChars),
    { role: 'user', content: buildQuestionDataMessage(question) },
  ];

  log(
    'chunk_start',
    {
      lineRange: `${chunk.startLine}-${chunk.endLine}`,
      sourceChars: chunk.text.length,
      historyMessageCount: messages.length - 3,
    },
    { verbose: true },
  );

  for (let round = 0; round < maxToolRounds; round += 1) {
    throwIfAborted(signal);
    log(
      'chunk_llm_request',
      {
        lineRange: `${chunk.startLine}-${chunk.endLine}`,
        round: round + 1,
        messageCount: messages.length,
      },
      { verbose: true },
    );
    const exhausted = eventBudget.remaining === 0;
    const requestMessages = exhausted
      ? [
          ...messages,
          { role: 'system', content: HIGHLIGHT_BUDGET_EXHAUSTED_PROMPT },
        ]
      : messages;
    const response = await send({
      type: MSG.llmChatCompletion,
      chatTurnId: turnId,
      messages: requestMessages,
      // Keep schemas for historical tool calls; disable only new calls.
      tools: [HIGHLIGHT_SPAN_TOOL],
      ...(exhausted ? { toolChoice: 'none' } : {}),
      taskType: LLM_TASK_TYPES.CHAT_ANSWER,
    });
    throwIfAborted(signal);
    if (!response?.ok) throw new Error(response?.error || 'LLM request failed');

    const rawCalls = Array.isArray(response.toolCalls) ? response.toolCalls : [];
    log(
      'chunk_llm_response',
      {
        lineRange: `${chunk.startLine}-${chunk.endLine}`,
        round: round + 1,
        responseChars: typeof response.content === 'string' ? response.content.length : 0,
        toolCallCount: rawCalls.length,
      },
      { verbose: true },
    );
    if (rawCalls.length === 0) {
      const reply = typeof response.content === 'string' ? response.content.trim() : '';
      log(
        'chunk_done',
        { lineRange: `${chunk.startLine}-${chunk.endLine}`, replyChars: reply.length },
        { verbose: true },
      );
      return reply;
    }

    const toolCalls = rawCalls.map((call, index) => ({
      ...call,
      id: call?.id || `highlight_${chunk.startLine}_${round + 1}_${index + 1}`,
    }));
    const assistantToolMessage = {
      role: 'assistant',
      content: typeof response.content === 'string' ? response.content : '',
      reasoning: response.reasoning,
      toolCalls,
    };
    messages.push(assistantToolMessage);
    // Provider reasoning may be required to continue the current tool loop,
    // but it is intentionally excluded from the persisted turn transcript.
    transcriptMessages.push({
      role: assistantToolMessage.role,
      content: assistantToolMessage.content,
      toolCalls,
    });

    for (const call of toolCalls) {
      throwIfAborted(signal);
      let result;
      // Every tool call resolves to exactly one outcome code; error outcomes
      // also carry the short model-facing message for the diagnostics recent list.
      let outcome;
      let outcomeError;
      if (call.name !== HIGHLIGHT_SPAN_TOOL.name) {
        outcome = CHAT_TOOL_OUTCOMES.UNKNOWN_TOOL;
        // call.name is model-generated and may echo article-derived text, so it
        // goes to the model (result) but is never persisted as a metric detail.
        result = `Unknown tool: ${call.name || '(missing name)'}`;
      } else {
        let range;
        try {
          range = validateHighlightArgs(call.arguments, sentenceCount, chunk);
        } catch (error) {
          // `code` is set by validateHighlightArgs; fall back to invalid_arguments.
          outcome = error.code || CHAT_TOOL_OUTCOMES.INVALID_ARGUMENTS;
          result = `Error: ${error.message}`;
          outcomeError = result;
        }
        if (range) {
          if (ranges.some((existing) => rangesOverlap(existing, range))) {
            outcome = CHAT_TOOL_OUTCOMES.OVERLAP_SKIPPED;
            result = `Skipped lines ${range.startLine}-${range.endLine}: that passage is already highlighted.`;
          } else if (eventBudget.remaining === 0) {
            outcome = CHAT_TOOL_OUTCOMES.BUDGET_EXHAUSTED;
            result =
              'Skipped: the turn-wide highlight budget is exhausted. Stop calling tools and finish with a normal text answer.';
          } else {
            // Reserve before awaiting paint so sibling workers share one budget.
            eventBudget.remaining -= 1;
            // Commit the range for persistence up front. onHighlight is a
            // best-effort streamed paint (UI only); a paint failure must not drop
            // the range or be reported to the model as a bad call — otherwise
            // it re-issues the same valid range and can loop.
            ranges.push(range);
            newRanges.push(range);
            result = `Highlighted lines ${range.startLine}-${range.endLine}.`;
            outcome = CHAT_TOOL_OUTCOMES.HIGHLIGHTED;
            try {
              throwIfAborted(signal);
              await onHighlight?.(range);
              throwIfAborted(signal);
            } catch (paintError) {
              throwIfAborted(signal);
              outcome = CHAT_TOOL_OUTCOMES.PAINT_FAILED;
              outcomeError = paintError?.message || String(paintError);
              log(
                'tool_paint_failed',
                {
                  lineRange: `${range.startLine}-${range.endLine}`,
                  error: outcomeError,
                },
                { error: true },
              );
            }
          }
        }
      }
      throwIfAborted(signal);
      recordToolMetric({ outcome, error: outcomeError });
      const toolResultMessage = { role: 'tool', content: result, toolCallId: call.id };
      messages.push(toolResultMessage);
      transcriptMessages.push(toolResultMessage);
      log(
        'tool_result',
        {
          lineRange: `${chunk.startLine}-${chunk.endLine}`,
          round: round + 1,
          tool: call.name || '(missing name)',
          outcome,
          result,
        },
        { verbose: true },
      );
    }
  }

  throw new Error('The LLM exceeded the tool-call round limit.');
}

/**
 * Run one LLM chat turn, including the assistant/tool result loop. Large
 * articles run through bounded source chunks and then synthesize their
 * findings. Pure with respect to its inputs: `highlightedRanges` is only read,
 * never mutated, and nothing is persisted here — the intermediate messages
 * and the new ranges are returned so the caller can commit the whole turn
 * atomically.
 *
 * `onHighlight(range)` fires as each new range is accepted, for streamed UI
 * painting only.
 *
 * The optional AbortSignal cancels local work immediately. Every provider
 * request also carries the stable turn id, and cancellation is forwarded to
 * the background boundary so in-flight provider work can be aborted there.
 *
 * @param {ArticleChatTurnOptions} options
 * @returns {Promise<{reply: string, transcriptMessages: object[], highlightRanges: Array<{startLine: number, endLine: number, label: string}>}>}
 */
export async function runArticleChatTurn(options = {}) {
  const {
    history,
    maxHistoryChars,
    question,
    sentences,
    onHighlight,
    highlightedRanges,
    maxChunkChars,
    maxToolRounds,
    maxLlmRequests,
    chunkConcurrency,
    turnId,
    signal: externalSignal,
    send,
    cancelTurn,
    recordToolMetric,
  } = normalizeArticleChatTurnOptions(options);
  const log = createChatLogger();
  const startedAt = Date.now();
  const resolvedTurnId = String(turnId || createTurnId());
  const turnController = new AbortController();
  let firstError;
  let cancelPosted = false;
  const postCancellation = () => {
    if (cancelPosted) return;
    cancelPosted = true;
    try {
      void Promise.resolve(cancelTurn?.({ turnId: resolvedTurnId })).catch(() => {});
    } catch (_) {
      // Cancellation is best-effort; retain the original turn failure.
    }
  };
  const abortTurn = (reason) => {
    if (turnController.signal.aborted) return;
    firstError = reason instanceof Error ? reason : abortReason(externalSignal);
    turnController.abort(firstError);
    postCancellation();
  };
  const onExternalAbort = () => abortTurn(abortReason(externalSignal));
  if (externalSignal?.aborted) onExternalAbort();
  else externalSignal?.addEventListener('abort', onExternalAbort, { once: true });

  try {
    throwIfAborted(turnController.signal);
    // Every request repeats the question alongside the source text, so the
    // question is charged against the same budget instead of being added on
    // top of a chunk that already fills the window. No amount of chunking can
    // rescue a question that fills the window on its own.
    const questionChars = String(question || '').length;
    // Source, replayed history and the question share one derived budget, so
    // the shares are taken from what the question leaves rather than each being
    // capped independently. Source never exceeds the caller's own ceiling: a
    // deliberately small maxChunkChars stays a chunking knob.
    const variableBudget = maxChunkChars + maxHistoryChars;
    const availableChars = variableBudget - questionChars;
    const historyBudget = Math.max(0, Math.min(maxHistoryChars, Math.floor(availableChars / 3)));
    const chunkBudget = Math.min(maxChunkChars, availableChars - historyBudget);
    // Below this the question has crowded out the article itself, and no
    // amount of chunking recovers a useful answer.
    if (chunkBudget < Math.min(maxChunkChars, MIN_SOURCE_CHUNK_CHARS)) {
      throw new Error(QUESTION_TOO_LONG_MESSAGE);
    }
    const chunks = chunkNumberedArticle(sentences, chunkBudget);
    if (!chunks.length) throw new Error('This record has no article text to chat about.');
    // Merging repeats the question in every payload. Reject a question that
    // leaves no room for the smallest possible merge before spending any
    // request, instead of overflowing the window at the end of the turn.
    if (chunks.length > 1 && minimumSynthesisChars(question) > variableBudget) {
      throw new Error(QUESTION_TOO_LONG_MESSAGE);
    }
    log('turn_start', {
      questionChars: String(question || '').length,
      sentenceCount: Array.isArray(sentences) ? sentences.length : 0,
      chunkCount: chunks.length,
      historyMessageCount: Array.isArray(history) ? history.length : 0,
      existingHighlightCount: Array.isArray(highlightedRanges) ? highlightedRanges.length : 0,
    });
    // Merging N findings at least SYNTHESIS_GROUP_MIN_SIZE at a time is a
    // binary tree with N leaves, so it costs at most N-1 requests. Reserving
    // exactly that keeps the chunk loop from consuming the budget the answer
    // still needs.
    const synthesisRequestReserve = chunks.length > 1 ? chunks.length - 1 : 0;
    const requestLimit =
      Number.isFinite(maxLlmRequests) && maxLlmRequests > 0
        ? Math.floor(maxLlmRequests)
        : Math.max(
            MIN_TURN_LLM_REQUESTS,
            chunks.length * DEFAULT_REQUESTS_PER_CHUNK + synthesisRequestReserve,
          );
    const chunkRequestLimit = Math.max(1, requestLimit - synthesisRequestReserve);
    let chunkRequestCount = 0;
    let turnRequestCount = 0;
    // Every provider request for this turn passes through here, so the
    // turn-wide limit and the logged count cover synthesis as well as chunks.
    const sendRequest = (payload) => {
      throwIfAborted(turnController.signal);
      if (turnRequestCount >= requestLimit) {
        throw new Error('The LLM exceeded the turn-wide request limit.');
      }
      turnRequestCount += 1;
      const pending = send({ ...payload, chatTurnId: resolvedTurnId });
      return awaitWithAbort(pending, turnController.signal);
    };
    const sendChunkRequest = (payload) => {
      throwIfAborted(turnController.signal);
      if (chunkRequestCount >= chunkRequestLimit) {
        throw new Error('The LLM exceeded the turn-wide request limit.');
      }
      chunkRequestCount += 1;
      return sendRequest(payload);
    };
    const results = new Array(chunks.length);
    // Highlight validation is turn-wide. Oversized source units can now appear
    // in multiple bounded chunks with the same global line number, so sibling
    // loops must see each other's accepted ranges and avoid duplicate paints.
    // The overlap check and push are synchronous before onHighlight is awaited,
    // which makes this shared array safe across the async chunk workers.
    // A losing sibling intentionally records OVERLAP_SKIPPED: it made a real
    // redundant tool call, even though only the winning highlight is painted.
    const acceptedRanges = [...highlightedRanges];
    const eventBudget = { remaining: MAX_TURN_EVENTS };
    let nextChunkIndex = 0;
    const worker = async () => {
      try {
        while (nextChunkIndex < chunks.length) {
          throwIfAborted(turnController.signal);
          const index = nextChunkIndex;
          nextChunkIndex += 1;
          const chunk = chunks[index];
          const chunkRanges = [];
          const chunkTranscript = [];
          const reply = await runArticleChatChunk({
            chunk,
            history,
            maxHistoryChars: historyBudget,
            question,
            sentenceCount: Array.isArray(sentences) ? sentences.length : 0,
            ranges: acceptedRanges,
            newRanges: chunkRanges,
            eventBudget,
            transcriptMessages: chunkTranscript,
            onHighlight,
            maxToolRounds,
            send: sendChunkRequest,
            signal: turnController.signal,
            turnId: resolvedTurnId,
            log,
            recordToolMetric,
          });
          throwIfAborted(turnController.signal);
          results[index] = {
            chunk,
            reply,
            transcriptMessages: chunkTranscript,
            highlightRanges: chunkRanges,
          };
        }
      } catch (error) {
        abortTurn(error);
        throw error;
      }
    };
    const concurrency = Math.max(1, Math.min(chunks.length, Math.floor(chunkConcurrency) || 1));
    const workerResults = await Promise.allSettled(
      Array.from({ length: concurrency }, () => worker()),
    );
    const failedWorker = workerResults.find((result) => result.status === 'rejected');
    if (failedWorker) throw firstError || failedWorker.reason;

    const transcriptMessages = results.flatMap((result) => result.transcriptMessages);
    const newRanges = results.flatMap((result) => result.highlightRanges);
    const chunkReplies = results.filter((result) => result.reply);
    if (!chunkReplies.length) throw new Error('The LLM returned an empty response.');
    if (chunkReplies.length === 1) {
      const result = {
        reply: chunkReplies[0].reply,
        transcriptMessages,
        highlightRanges: newRanges,
      };
      log('turn_done', {
        durationMs: Date.now() - startedAt,
        requestCount: turnRequestCount,
        replyChars: result.reply.length,
        newHighlightCount: newRanges.length,
      });
      return result;
    }

    // A synthesis request replays no conversation history, so the findings may
    // use the history budget as well as the source budget.
    const synthesisCapacity = variableBudget;
    let synthesisInputs = chunkReplies;
    while (synthesisInputs.length > 1) {
      const groups = groupSynthesisReplies(question, synthesisInputs, synthesisCapacity);
      const nextLevel = [];
      for (const group of groups) {
        // A trailing odd finding has nothing to merge with. Carrying it to the
        // next level costs no request and loses nothing: the next level trims
        // it to the same share of the same capacity.
        if (group.length < SYNTHESIS_GROUP_MIN_SIZE) {
          nextLevel.push(group[0]);
          continue;
        }
        log('synthesis_llm_request', { chunkReplyCount: group.length }, { verbose: true });
        const synthesis = await sendRequest({
          type: MSG.llmChatCompletion,
          messages: buildSynthesisMessages(question, group),
          taskType: LLM_TASK_TYPES.CHAT_SYNTHESIS,
        });
        if (!synthesis?.ok) throw new Error(synthesis?.error || 'LLM request failed');
        const reply = typeof synthesis.content === 'string' ? synthesis.content.trim() : '';
        if (!reply) throw new Error('The LLM returned an empty response.');
        nextLevel.push({
          chunk: {
            startLine: group[0].chunk.startLine,
            endLine: group.at(-1).chunk.endLine,
          },
          reply,
        });
      }
      if (nextLevel.length >= synthesisInputs.length) {
        throw new Error('The synthesis input exceeds the configured chat context limit.');
      }
      synthesisInputs = nextLevel;
    }
    const reply = synthesisInputs[0].reply;
    log('turn_done', {
      durationMs: Date.now() - startedAt,
      requestCount: turnRequestCount,
      replyChars: reply.length,
      newHighlightCount: newRanges.length,
    });
    return { reply, transcriptMessages, highlightRanges: newRanges };
  } catch (error) {
    abortTurn(error);
    log(
      'turn_error',
      { durationMs: Date.now() - startedAt, error: error?.message || String(error) },
      {
        error: true,
      },
    );
    throw firstError || error;
  } finally {
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
}
