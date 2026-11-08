import { describe, expect, it, vi } from 'vitest';
import { runArticleChatTurn } from './articleChat.js';
import { PROJECT_CHAT_SYSTEM_PROMPT } from './articleChatPrompts.js';
import { CHAT_TOOL_OUTCOMES } from '../shared/runtime/telemetry.js';

const source = { kind: 'project', preamble: 'Included pages: A, B. Top topics: Cats.' };

function turn({
  send,
  tools = [],
  maxChunkChars = 4000,
  recordToolMetric = vi.fn(),
  history = [],
}) {
  return runArticleChatTurn({
    article: { history, sentences: [], source },
    tools,
    question: 'What do the pages say about cats?',
    limits: { maxChunkChars, maxHistoryChars: 1000 },
    dependencies: { send, cancelTurn: vi.fn(), recordToolMetric },
  });
}

const searchTopics = (run) => ({
  definition: { name: 'search_topics', description: 'Search.', parameters: { type: 'object' } },
  run: vi.fn(run),
});

describe('project chat turns', () => {
  it('sends the project prompt, the preamble and only the supplied tools', async () => {
    const send = vi.fn().mockResolvedValue({ ok: true, content: 'Answer.' });
    const result = await turn({
      send,
      tools: [searchTopics(async () => '')],
      history: [
        { role: 'user', content: 'Earlier' },
        { role: 'assistant', content: 'Reply' },
      ],
    });

    expect(result).toEqual({ reply: 'Answer.', transcriptMessages: [], highlightRanges: [] });
    expect(send).toHaveBeenCalledTimes(1);
    const request = send.mock.calls[0][0];
    expect(request.messages[0]).toEqual({ role: 'system', content: PROJECT_CHAT_SYSTEM_PROMPT });
    expect(request.messages.filter((m) => m.role === 'system')).toHaveLength(1);
    expect(JSON.parse(request.messages[1].content)).toEqual({
      kind: 'project',
      overview: source.preamble,
    });
    expect(request.messages.slice(2).map((m) => m.content)).toEqual([
      'Earlier',
      'Reply',
      JSON.stringify({ kind: 'question', text: 'What do the pages say about cats?' }),
    ]);
    expect(request.tools.map((definition) => definition.name)).toEqual(['search_topics']);
  });

  it('runs tools, and treats highlight_span as an unknown tool', async () => {
    let round = 0;
    const send = vi.fn(async () => {
      round += 1;
      if (round === 1) {
        return {
          ok: true,
          content: '',
          toolCalls: [
            { id: 'c1', name: 'search_topics', arguments: { query: 'cats' } },
            { id: 'c2', name: 'highlight_span', arguments: { startLine: 1, endLine: 1 } },
          ],
        };
      }
      return { ok: true, content: 'Cats purr (Cat facts, sentences 2–3).' };
    });
    const tool = searchTopics(async () => 'Cats > Purring — Cat facts, sentences 2–3');
    const recordToolMetric = vi.fn();
    const onHighlight = vi.fn();
    const result = await runArticleChatTurn({
      article: { history: [], sentences: [], source },
      tools: [tool],
      question: 'Why do cats purr?',
      limits: { maxChunkChars: 4000, maxHistoryChars: 0 },
      effects: { onHighlight },
      dependencies: { send, cancelTurn: vi.fn(), recordToolMetric },
    });

    expect(result.reply).toBe('Cats purr (Cat facts, sentences 2–3).');
    expect(result.highlightRanges).toEqual([]);
    expect(onHighlight).not.toHaveBeenCalled();
    expect(tool.run).toHaveBeenCalledWith(
      { query: 'cats' },
      expect.objectContaining({ maxChars: expect.any(Number) }),
    );
    const toolMessages = send.mock.calls[1][0].messages.filter((m) => m.role === 'tool');
    expect(toolMessages.map((m) => m.content)).toEqual([
      'Cats > Purring — Cat facts, sentences 2–3',
      'Unknown tool: highlight_span',
    ]);
    expect(recordToolMetric.mock.calls.map(([sample]) => sample.outcome)).toEqual([
      CHAT_TOOL_OUTCOMES.TOOL_RESULT,
      CHAT_TOOL_OUTCOMES.UNKNOWN_TOOL,
    ]);
  });

  it('shares the source budget between the preamble and tool results', async () => {
    let calls = 0;
    const send = vi.fn(async () => {
      calls += 1;
      return calls < 4
        ? { ok: true, content: '', toolCalls: [{ id: `c${calls}`, name: 'search_topics' }] }
        : { ok: true, content: 'Done.' };
    });
    const tool = searchTopics(async () => 'y'.repeat(5000));
    await turn({ send, tools: [tool], maxChunkChars: 1200 });

    const messages = send.mock.calls[3][0].messages;
    const overview = JSON.parse(messages[1].content).overview;
    const toolChars = messages
      .filter((m) => m.role === 'tool' && !m.content.startsWith('Skipped:'))
      .reduce((sum, message) => sum + message.content.length, 0);
    // The preamble and every tool result draw on the one 1200-char source budget.
    expect(overview.length + toolChars).toBeLessThanOrEqual(1200);
    expect(messages.filter((m) => m.role === 'tool').at(-1).content).toMatch(
      /^Skipped: no context budget/,
    );
  });

  it('caps an oversized preamble so tools keep room', async () => {
    const send = vi.fn().mockResolvedValue({ ok: true, content: 'Answer.' });
    await runArticleChatTurn({
      article: {
        history: [],
        sentences: [],
        source: { kind: 'project', preamble: 'p'.repeat(5000) },
      },
      question: 'Q?',
      limits: { maxChunkChars: 1000, maxHistoryChars: 0 },
      dependencies: { send, cancelTurn: vi.fn(), recordToolMetric: vi.fn() },
    });
    const overview = JSON.parse(send.mock.calls[0][0].messages[1].content).overview;
    expect(overview.length).toBeLessThanOrEqual(500);
    expect(overview).toMatch(/\[overview truncated\]$/);
  });
});
