import { describe, expect, it, vi } from 'vitest';
import { runArticleChatTurn } from './articleChat.js';
import { EXCERPT_CHAT_SYSTEM_PROMPT } from './articleChatPrompts.js';
import { CHAT_TOOL_OUTCOMES } from '../shared/runtime/telemetry.js';

const source = { kind: 'excerpt', pageTitle: 'A page', pageUrl: 'https://a.test/' };

function turn({ send, tools, maxChunkChars = 4000, recordToolMetric = vi.fn() }) {
  return runArticleChatTurn({
    article: { history: [], sentences: ['The excerpt sentence.'], source },
    tools,
    question: 'What is the context?',
    limits: { maxChunkChars, maxHistoryChars: 0 },
    dependencies: { send, cancelTurn: vi.fn(), recordToolMetric },
  });
}

const readPage = (run) => ({
  definition: { name: 'read_page', description: 'Read the page.', parameters: { type: 'object' } },
  run: vi.fn(run),
});

describe('excerpt chat turns', () => {
  it('frames the excerpt with its page and offers the extra tool', async () => {
    const send = vi.fn().mockResolvedValue({ ok: true, content: 'Answer.' });
    const tool = readPage(async () => 'page');
    await turn({ send, tools: [tool] });

    const request = send.mock.calls[0][0];
    expect(request.messages[1]).toEqual({ role: 'system', content: EXCERPT_CHAT_SYSTEM_PROMPT });
    expect(JSON.parse(request.messages[2].content)).toEqual({
      kind: 'excerpt_chunk',
      page: { title: 'A page', url: 'https://a.test/' },
      startLine: 1,
      endLine: 1,
      numberedText: '1: The excerpt sentence.',
    });
    expect(request.tools.map((definition) => definition.name)).toEqual([
      'highlight_span',
      'read_page',
    ]);
  });

  it('runs the extra tool and feeds its result back to the model', async () => {
    const send = vi.fn(async ({ messages }) =>
      messages.at(-1).role === 'tool'
        ? { ok: true, content: 'Answer with context.' }
        : { ok: true, content: '', toolCalls: [{ id: 'c1', name: 'read_page', arguments: {} }] },
    );
    const tool = readPage(async () => 'the rest of the page');
    const recordToolMetric = vi.fn();
    const result = await turn({ send, tools: [tool], recordToolMetric });

    expect(result.reply).toBe('Answer with context.');
    expect(tool.run).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ maxChars: expect.any(Number) }),
    );
    expect(send.mock.calls[1][0].messages.at(-1)).toEqual({
      role: 'tool',
      content: 'the rest of the page',
      toolCallId: 'c1',
    });
    expect(recordToolMetric).toHaveBeenCalledWith({
      outcome: CHAT_TOOL_OUTCOMES.TOOL_RESULT,
      error: undefined,
    });
  });

  it('reports a failed tool to the model instead of failing the turn', async () => {
    const send = vi.fn(async ({ messages }) =>
      messages.at(-1).role === 'tool'
        ? { ok: true, content: 'Answer without the page.' }
        : { ok: true, content: '', toolCalls: [{ id: 'c1', name: 'read_page', arguments: {} }] },
    );
    const tool = readPage(async () => {
      throw new Error('tab closed');
    });
    const result = await turn({ send, tools: [tool] });

    expect(result.reply).toBe('Answer without the page.');
    expect(send.mock.calls[1][0].messages.at(-1).content).toBe('Error: tab closed');
  });

  it('caps tool results to the chunk’s leftover budget', async () => {
    let calls = 0;
    const send = vi.fn(async () => {
      calls += 1;
      return calls < 4
        ? { ok: true, content: '', toolCalls: [{ id: `c${calls}`, name: 'read_page' }] }
        : { ok: true, content: 'Done.' };
    });
    const tool = readPage(async () => 'y'.repeat(5000));
    await turn({ send, tools: [tool], maxChunkChars: 1200 });

    const toolMessages = send.mock.calls[3][0].messages.filter((m) => m.role === 'tool');
    const total = toolMessages.reduce((sum, message) => sum + message.content.length, 0);
    expect(total).toBeLessThanOrEqual(1200 + 200);
    expect(toolMessages.at(-1).content).toMatch(/^Skipped: no context budget/);
  });
});
