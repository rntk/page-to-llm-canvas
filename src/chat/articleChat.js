import { MSG } from '../../messages.js';
import { sendRuntimeMessage } from '../utils/runtimeMessages.js';

export const ARTICLE_CHAT_SYSTEM_PROMPT = `You are an intelligent assistant helping a user explore one article.
The current article is supplied inside <article> tags. Each sentence is prefixed with its 1-based line number.
Answer in the same language as the article and ground claims in the supplied text.

Use highlight_span when pointing to specific evidence would help the user. Prefer the shortest useful range.
You may call it more than once for distinct passages. Do not repeat or overlap a range already highlighted.
After highlighting the relevant passages, stop calling tools and give the user a normal text answer.`;

export const CHAT_TEMPERATURE = 0.8;

export const HIGHLIGHT_SPAN_TOOL = Object.freeze({
  name: 'highlight_span',
  description:
    'Highlight one or more consecutive article sentences. Use the 1-based line numbers shown in the article context.',
  parameters: {
    type: 'object',
    properties: {
      start_line: {
        type: 'integer',
        description: 'First line number, 1-based and inclusive.',
      },
      end_line: {
        type: 'integer',
        description: 'Last line number, 1-based and inclusive.',
      },
      label: {
        type: 'string',
        description: 'Optional short explanation of why this passage matters.',
      },
    },
    required: ['start_line', 'end_line'],
    additionalProperties: false,
  },
});

export function buildNumberedArticle(sentences) {
  return (Array.isArray(sentences) ? sentences : [])
    .map((sentence, index) => `${index + 1}: ${String(sentence || '').trim()}`)
    .filter((line) => !/^\d+:\s*$/.test(line))
    .join('\n');
}

export function rangesOverlap(a, b) {
  return a.startLine <= b.endLine && b.startLine <= a.endLine;
}

function validateHighlightArgs(args, sentenceCount) {
  const startLine = Number(args?.start_line);
  const endLine = Number(args?.end_line);
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) {
    throw new Error('start_line and end_line must be integers');
  }
  if (startLine < 1 || endLine < startLine || endLine > sentenceCount) {
    throw new Error(`line range must be between 1 and ${sentenceCount}`);
  }
  return {
    startLine,
    endLine,
    label: typeof args?.label === 'string' ? args.label : '',
  };
}

/**
 * Drop tool-call pairs that would 400 on OpenAI-compatible replay: an
 * assistant message whose tool calls are not each immediately answered by a
 * matching `tool` result, and `tool` results whose id no preceding assistant
 * message asked for. History persisted by the old per-message scheme can
 * contain both (a mid-turn failure left a dangling assistant tool call), so
 * stored data cannot be trusted here. Single forward pass.
 */
function sanitizeHistory(history) {
  const source = (Array.isArray(history) ? history : []).filter((message) =>
    ['user', 'assistant', 'tool'].includes(message?.role),
  );
  const kept = [];
  // Call ids of the last kept assistant tool-call message that still await
  // their `tool` result; anything else makes a `tool` message an orphan.
  let pendingCallIds = null;
  for (let index = 0; index < source.length; index += 1) {
    const message = source[index];
    if (message.role === 'tool') {
      if (pendingCallIds?.has(message.toolCallId)) {
        pendingCallIds.delete(message.toolCallId);
        kept.push(message);
      }
      continue;
    }
    pendingCallIds = null;
    const callIds = Array.isArray(message.toolCalls)
      ? message.toolCalls.map((call) => call?.id)
      : [];
    if (message.role === 'assistant' && callIds.length) {
      // Every call id must be answered by the tool messages that directly
      // follow; otherwise drop the assistant message (its now-orphaned tool
      // results fall out via the `pendingCallIds` check above).
      const unanswered = new Set(callIds);
      let next = index + 1;
      while (unanswered.size && source[next]?.role === 'tool') {
        unanswered.delete(source[next].toolCallId);
        next += 1;
      }
      if (unanswered.size) continue;
      pendingCallIds = new Set(callIds);
    }
    kept.push(message);
  }
  return kept;
}

/**
 * Run one LLM chat turn, including the assistant/tool result loop. Pure with
 * respect to its inputs: `highlightedRanges` is only read, never mutated, and
 * nothing is persisted here — the intermediate messages and the new ranges
 * are returned so the caller can commit the whole turn atomically.
 *
 * `onHighlight(range)` fires as each new range is accepted, for live UI
 * painting only.
 *
 * @returns {Promise<{
 *   reply: string,
 *   transcriptMessages: object[],
 *   highlightRanges: {startLine: number, endLine: number, label: string}[],
 * }>}
 */
export async function runArticleChatTurn({
  history,
  question,
  sentences,
  onHighlight,
  highlightedRanges = [],
  maxToolRounds = 8,
  send = sendRuntimeMessage,
}) {
  const numberedArticle = buildNumberedArticle(sentences);
  if (!numberedArticle) throw new Error('This record has no article text to chat about.');

  const messages = [
    { role: 'system', content: ARTICLE_CHAT_SYSTEM_PROMPT },
    ...sanitizeHistory(history).map((message) => ({
      role: message.role,
      content: String(message.content || ''),
      ...(message.reasoning ? { reasoning: message.reasoning } : {}),
      ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
      ...(Array.isArray(message.toolCalls) ? { toolCalls: message.toolCalls } : {}),
    })),
    {
      role: 'user',
      content: `<question>${question}</question>\n\n<article>\n${numberedArticle}\n</article>`,
    },
  ];
  // Local copy: the input array aliases caller state and must stay untouched.
  const ranges = [...highlightedRanges];
  const newRanges = [];
  const transcriptMessages = [];

  for (let round = 0; round < maxToolRounds; round += 1) {
    const response = await send({
      type: MSG.llmChatCompletion,
      messages,
      tools: [HIGHLIGHT_SPAN_TOOL],
      temperature: CHAT_TEMPERATURE,
    });
    if (!response?.ok) throw new Error(response?.error || 'LLM request failed');

    const rawCalls = Array.isArray(response.toolCalls) ? response.toolCalls : [];
    if (rawCalls.length === 0) {
      const reply = typeof response.content === 'string' ? response.content.trim() : '';
      if (!reply) throw new Error('The LLM returned an empty response.');
      return { reply, transcriptMessages, highlightRanges: newRanges };
    }

    const toolCalls = rawCalls.map((call, index) => ({
      ...call,
      id: call?.id || `highlight_${round + 1}_${index + 1}`,
    }));
    const assistantToolMessage = {
      role: 'assistant',
      content: typeof response.content === 'string' ? response.content : '',
      reasoning: response.reasoning,
      toolCalls,
    };
    messages.push(assistantToolMessage);
    transcriptMessages.push(assistantToolMessage);

    for (const call of toolCalls) {
      let result;
      if (call.name !== HIGHLIGHT_SPAN_TOOL.name) {
        result = `Unknown tool: ${call.name || '(missing name)'}`;
      } else {
        try {
          const range = validateHighlightArgs(call.arguments, sentences.length);
          if (ranges.some((existing) => rangesOverlap(existing, range))) {
            result = `Skipped lines ${range.startLine}-${range.endLine}: that passage is already highlighted.`;
          } else {
            await onHighlight?.(range);
            ranges.push(range);
            newRanges.push(range);
            result = `Highlighted lines ${range.startLine}-${range.endLine}.`;
          }
        } catch (error) {
          result = `Error: ${error.message}`;
        }
      }
      const toolResultMessage = { role: 'tool', content: result, toolCallId: call.id };
      messages.push(toolResultMessage);
      transcriptMessages.push(toolResultMessage);
    }
  }

  throw new Error('The LLM exceeded the tool-call round limit.');
}
