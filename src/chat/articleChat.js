import { MSG } from '../../messages.js';
import { sendRuntimeMessage } from '../utils/runtimeMessages.js';

export const ARTICLE_CHAT_SYSTEM_PROMPT = `You are an intelligent assistant helping a user explore one article.
The current article is supplied inside <article> tags. Each sentence is prefixed with its 1-based line number.
Answer in the same language as the article and ground claims in the supplied text.

Use highlight_span when pointing to specific evidence would help the user. Prefer the shortest useful range.
You may call it more than once for distinct passages. Do not repeat or overlap a range already highlighted.
After highlighting the relevant passages, stop calling tools and give the user a normal text answer.`;

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

/** Run one llama.cpp chat turn, including the assistant/tool result loop. */
export async function runArticleChatTurn({
  history,
  question,
  sentences,
  onHighlight,
  highlightedRanges = [],
  maxToolRounds = 8,
  send = sendRuntimeMessage,
  onTranscriptMessage,
}) {
  const numberedArticle = buildNumberedArticle(sentences);
  if (!numberedArticle) throw new Error('This record has no article text to chat about.');

  const messages = [
    { role: 'system', content: ARTICLE_CHAT_SYSTEM_PROMPT },
    ...(Array.isArray(history)
      ? history
          .filter((message) => ['user', 'assistant', 'tool'].includes(message?.role))
          .map((message) => ({
            role: message.role,
            content: String(message.content || ''),
            ...(message.reasoning ? { reasoning: message.reasoning } : {}),
            ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
            ...(Array.isArray(message.toolCalls) ? { toolCalls: message.toolCalls } : {}),
          }))
      : []),
    {
      role: 'user',
      content: `<question>${question}</question>\n\n<article>\n${numberedArticle}\n</article>`,
    },
  ];
  const ranges = highlightedRanges;

  for (let round = 0; round < maxToolRounds; round += 1) {
    const response = await send({
      type: MSG.llmChatCompletion,
      messages,
      tools: [HIGHLIGHT_SPAN_TOOL],
      temperature: 0.8,
    });
    if (!response?.ok) throw new Error(response?.error || 'LLM request failed');

    const rawCalls = Array.isArray(response.toolCalls) ? response.toolCalls : [];
    if (rawCalls.length === 0) {
      const reply = typeof response.content === 'string' ? response.content.trim() : '';
      if (!reply) throw new Error('The LLM returned an empty response.');
      return { reply, highlightedRanges: ranges };
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
    await onTranscriptMessage?.(assistantToolMessage);

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
            result = `Highlighted lines ${range.startLine}-${range.endLine}.`;
          }
        } catch (error) {
          result = `Error: ${error.message}`;
        }
      }
      const toolResultMessage = { role: 'tool', content: result, toolCallId: call.id };
      messages.push(toolResultMessage);
      await onTranscriptMessage?.(toolResultMessage);
    }
  }

  throw new Error('The LLM exceeded the tool-call round limit.');
}
