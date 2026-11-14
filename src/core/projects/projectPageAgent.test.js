import { describe, expect, it, vi } from 'vitest';
import {
  ASK_PAGE_AGENT_TOOL,
  DEFAULT_PAGE_AGENT_MAX_ROUNDS,
  PAGE_AGENT_SYSTEM_PROMPT,
  buildPageAgentDataMessage,
  createPageAgentTool,
} from './projectPageAgent.js';

const pages = [
  { page: 1, title: 'Cats', url: 'https://cats.test/' },
  { page: 2, title: 'Dogs', url: 'https://dogs.test/a#intro' },
  { page: 3, title: 'Broken', url: 'https://broken.test/' },
  { page: 4, title: 'Empty', url: 'https://empty.test/' },
];

const longLines = Array.from(
  { length: 40 },
  (_, i) => `Line number ${i + 1} talks about something fairly unremarkable.`,
);

const texts = {
  1: ['Cats purr when happy.', 'Cats sleep a lot.', 'Some cats dislike water.'],
  2: longLines,
  4: [],
};

const answer = (content, extra = {}) => ({ ok: true, content, ...extra });
const callTool = (name, args, id = 'c1') => ({
  ok: true,
  content: '',
  toolCalls: [{ id, name, arguments: args }],
});

function setup({ responses = [], ...options } = {}) {
  const loadPage = vi.fn(async (page) => {
    if (page.page === 3) throw new Error('capture failed');
    return { sentences: texts[page.page] };
  });
  const complete = vi.fn();
  for (const response of responses) complete.mockResolvedValueOnce(response);
  const tool = createPageAgentTool({ pages, loadPage, complete, ...options });
  const run = async (args, runOptions = { maxChars: 20_000 }) =>
    JSON.parse(await tool.run(args, runOptions));
  return { tool, run, loadPage, complete };
}

const dataOf = (complete, call = 0) => JSON.parse(complete.mock.calls[call][0].messages[1].content);
const toolMessages = (complete, call) =>
  complete.mock.calls[call][0].messages.filter((m) => m.role === 'tool');

describe('definition', () => {
  it('is ask_page_agent and requires prompt', () => {
    const { tool } = setup();
    expect(tool.definition).toBe(ASK_PAGE_AGENT_TOOL);
    expect(tool.definition.name).toBe('ask_page_agent');
    expect(tool.definition.parameters.required).toEqual(['prompt']);
    expect(DEFAULT_PAGE_AGENT_MAX_ROUNDS).toBeGreaterThan(1);
  });
});

describe('createPageAgentTool', () => {
  it('requires loadPage and complete', () => {
    expect(() => createPageAgentTool({ pages, complete: vi.fn() })).toThrow(/loadPage/);
    expect(() => createPageAgentTool({ pages, loadPage: vi.fn() })).toThrow(/complete/);
  });
});

describe('argument validation', () => {
  it('rejects bad prompts', async () => {
    const { run, complete } = setup();
    await expect(run({ page: 1 })).rejects.toThrow(/prompt is required/);
    await expect(run({ page: 1, prompt: '   ' })).rejects.toThrow(/prompt is required/);
    await expect(run({ page: 1, prompt: 'x'.repeat(2001) })).rejects.toThrow(/at most 2000/);
    expect(complete).not.toHaveBeenCalled();
  });

  it('rejects unknown or malformed page identifiers', async () => {
    const { run, complete } = setup();
    await expect(run({ page: 99, prompt: 'q' })).rejects.toThrow(/valid pages are 1–4/);
    await expect(run({ page: true, prompt: 'q' })).rejects.toThrow(/not a project page/);
    await expect(run({ url: 'https://nowhere.test/', prompt: 'q' })).rejects.toThrow(
      /no project page has the URL/,
    );
    await expect(run({ prompt: 'q' })).rejects.toThrow(/page or url is required/);
    expect(complete).not.toHaveBeenCalled();
  });
});

describe('page resolution', () => {
  it('resolves by url, ignoring a #fragment, to the same page as by number', async () => {
    const { run } = setup({
      responses: [answer('a'), answer('b'), answer('c')],
    });
    const byNumber = await run({ page: 2, prompt: 'q' });
    const byUrl = await run({ url: 'https://dogs.test/a', prompt: 'q' });
    const byFragmentUrl = await run({ url: 'https://dogs.test/a#other', prompt: 'q' });
    for (const result of [byNumber, byUrl, byFragmentUrl]) {
      expect(result.page).toBe(2);
      expect(result.title).toBe('Dogs');
    }
  });
});

describe('short page', () => {
  it('is answered in one request without tool calls', async () => {
    const { run, complete } = setup({ responses: [answer('  Cats purr (lines 1–1).  ')] });
    const result = await run({ page: 1, prompt: 'What do cats do?' });

    expect(complete).toHaveBeenCalledTimes(1);
    const request = complete.mock.calls[0][0];
    expect(request.messages).toHaveLength(2);
    expect(request.messages[0]).toEqual({ role: 'system', content: PAGE_AGENT_SYSTEM_PROMPT });
    expect(request.messages[1].role).toBe('user');
    const data = JSON.parse(request.messages[1].content);
    expect(data).toMatchObject({
      kind: 'page_agent_task',
      page: { page: 1, title: 'Cats', url: 'https://cats.test/', totalLines: 3 },
      shownThroughLine: 3,
      note: 'The whole page is shown.',
      task: 'What do cats do?',
    });
    expect(data.numberedText.split('\n')).toEqual([
      '1: Cats purr when happy.',
      '2: Cats sleep a lot.',
      '3: Some cats dislike water.',
    ]);
    expect(request.tools.map((t) => t.name)).toEqual(['read_page', 'search_page']);
    expect(request.taskType).toBe('chat_page_agent');
    expect(request).not.toHaveProperty('toolChoice');

    expect(result).toMatchObject({
      kind: 'page_agent_answer',
      page: 1,
      title: 'Cats',
      prompt: 'What do cats do?',
      requests: 1,
      answer: 'Cats purr (lines 1–1).',
    });
    expect(result.note).toEqual(expect.any(String));
  });
});

describe('long page', () => {
  const options = { maxChunkChars: 1500 };

  it('shows only the opening lines and lets the helper read on', async () => {
    const { run, complete } = setup({
      ...options,
      responses: [callTool('read_page', { page: 2, start_line: 30 }), answer('Found it.')],
    });
    const result = await run({ page: 2, prompt: 'Look at the end' });

    const data = dataOf(complete);
    expect(data.shownThroughLine).toBeLessThan(data.page.totalLines);
    expect(data.shownThroughLine).toBeGreaterThan(0);
    expect(data.note).toMatch(/read_page/);
    expect(data.numberedText.split('\n')).toHaveLength(data.shownThroughLine);

    expect(complete).toHaveBeenCalledTimes(2);
    const second = complete.mock.calls[1][0].messages;
    expect(second.at(-2)).toMatchObject({
      role: 'assistant',
      toolCalls: [{ id: 'c1', name: 'read_page', arguments: { page: 2, start_line: 30 } }],
    });
    expect(second.at(-1)).toMatchObject({ role: 'tool', toolCallId: 'c1' });
    const toolResult = JSON.parse(second.at(-1).content);
    expect(toolResult).toMatchObject({ kind: 'page_text', page: 2, startLine: 30 });
    expect(toolResult.numberedText).toContain('Line number 30');
    expect(result.answer).toBe('Found it.');
    expect(result.requests).toBe(2);
  });

  it('supports search_page the same way', async () => {
    const { run, complete } = setup({
      ...options,
      responses: [callTool('search_page', { page: 2, query: 'number 37' }), answer('Line 37.')],
    });
    const result = await run({ page: 2, prompt: 'find 37' });
    const toolResult = JSON.parse(toolMessages(complete, 1)[0].content);
    expect(toolResult).toMatchObject({ kind: 'page_search', page: 2 });
    expect(toolResult.matches.some((m) => m.line === 37)).toBe(true);
    expect(result.requests).toBe(2);
  });

  it('cannot read a different page', async () => {
    const { run, complete } = setup({
      ...options,
      responses: [callTool('read_page', { page: 1 }), answer('done')],
    });
    await run({ page: 2, prompt: 'q' });
    const [message] = toolMessages(complete, 1);
    expect(message.toolCallId).toBe('c1');
    expect(message.content).toMatch(/^Error:/);
  });

  it('assigns an id to tool calls that lack one', async () => {
    const { run, complete } = setup({
      ...options,
      responses: [
        {
          ok: true,
          content: '',
          toolCalls: [{ name: 'search_page', arguments: { query: 'line' } }],
        },
        answer('done'),
      ],
    });
    await run({ page: 2, prompt: 'q' });
    const second = complete.mock.calls[1][0].messages;
    const id = second.at(-2).toolCalls[0].id;
    expect(id).toBeTruthy();
    expect(second.at(-1).toolCallId).toBe(id);
  });
});

describe('tool failures', () => {
  it('reports an unknown tool and continues', async () => {
    const { run, complete } = setup({
      responses: [callTool('xyz', {}), answer('ok')],
    });
    const result = await run({ page: 1, prompt: 'q' });
    expect(toolMessages(complete, 1)[0]).toMatchObject({
      content: 'Unknown tool: xyz',
      toolCallId: 'c1',
    });
    expect(result.answer).toBe('ok');
  });

  it('reports a missing tool name', async () => {
    const { run, complete } = setup({
      responses: [
        { ok: true, content: '', toolCalls: [{ id: 'c1', arguments: {} }] },
        answer('ok'),
      ],
    });
    await run({ page: 1, prompt: 'q' });
    expect(toolMessages(complete, 1)[0].content).toBe('Unknown tool: (missing name)');
  });

  it('turns a throwing tool into an Error: message and continues', async () => {
    const { run, complete, loadPage } = setup({
      maxChunkChars: 1500,
      responses: [callTool('read_page', { page: 2, start_line: 20 }), answer('recovered')],
    });
    // The first load (for the agent itself) works; the helper's read_page load fails.
    loadPage.mockImplementationOnce(async () => ({ sentences: texts[2] }));
    loadPage.mockImplementationOnce(async () => {
      throw new Error('reader exploded');
    });
    const result = await run({ page: 2, prompt: 'q' });
    expect(toolMessages(complete, 1)[0].content).toBe('Error: reader exploded');
    expect(result.answer).toBe('recovered');
  });
});

describe('round limit', () => {
  it('forces a final answer with toolChoice none and uses its content', async () => {
    const { run, complete } = setup({
      maxRounds: 2,
      responses: [
        callTool('search_page', { query: 'cats' }),
        {
          ok: true,
          content: ' Final words ',
          toolCalls: [{ id: 'c2', name: 'search_page', arguments: { query: 'x' } }],
        },
      ],
    });
    const result = await run({ page: 1, prompt: 'q' });
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[0][0]).not.toHaveProperty('toolChoice');
    expect(complete.mock.calls[1][0].toolChoice).toBe('none');
    expect(result.answer).toBe('Final words');
    expect(result.requests).toBe(2);
  });

  it('rejects when the last response is empty', async () => {
    const { run } = setup({
      maxRounds: 2,
      responses: [
        callTool('search_page', { query: 'cats' }),
        callTool('search_page', { query: 'x' }, 'c2'),
      ],
    });
    await expect(run({ page: 1, prompt: 'q' })).rejects.toThrow(/empty answer/);
  });

  it('rejects an empty answer on the first round too', async () => {
    const { run } = setup({ responses: [answer('   ')] });
    await expect(run({ page: 1, prompt: 'q' })).rejects.toThrow(/empty answer/);
  });
});

describe('failures', () => {
  it('rejects with the completion error', async () => {
    const { run } = setup({ responses: [{ ok: false, error: 'boom' }] });
    await expect(run({ page: 1, prompt: 'q' })).rejects.toThrow(/boom/);
  });

  it('uses a generic message when the completion has no error text', async () => {
    const { run } = setup({ responses: [undefined] });
    await expect(run({ page: 1, prompt: 'q' })).rejects.toThrow(/helper request failed/);
  });

  it('propagates a loadPage rejection', async () => {
    const { run, complete } = setup();
    await expect(run({ page: 3, prompt: 'q' })).rejects.toThrow('capture failed');
    expect(complete).not.toHaveBeenCalled();
  });

  it('rejects a page without readable text', async () => {
    const { run } = setup();
    await expect(run({ page: 4, prompt: 'q' })).rejects.toThrow(/no readable text/);
  });
});

describe('budgets', () => {
  it('skips tool calls once the data message used the context budget', async () => {
    const { run, complete } = setup({
      maxChunkChars: 300,
      responses: [callTool('read_page', { page: 2, start_line: 5 }), answer('from memory')],
    });
    const result = await run({ page: 2, prompt: 'q' });
    const data = dataOf(complete);
    expect(data.shownThroughLine).toBeLessThan(data.page.totalLines);
    expect(toolMessages(complete, 1)[0].content).toMatch(/^Skipped: no context budget/);
    expect(result.answer).toBe('from memory');
  });

  it('truncates the answer to fit maxChars', async () => {
    const long = 'word '.repeat(400).trim();
    const { tool } = setup({ responses: [answer(long), answer(long)] });
    const full = await tool.run({ page: 1, prompt: 'q' }, { maxChars: 20_000 });
    const budget = 600;
    expect(full.length).toBeGreaterThan(budget);
    const json = await tool.run({ page: 1, prompt: 'q' }, { maxChars: budget });
    expect(json.length).toBeLessThanOrEqual(budget);
    const parsed = JSON.parse(json);
    expect(parsed.answer.endsWith('[answer truncated]')).toBe(true);
    expect(parsed.answer.length).toBeLessThan(long.length);
  });

  it('rejects when maxChars cannot hold even the envelope', async () => {
    const { run } = setup({ responses: [answer('text')] });
    await expect(run({ page: 1, prompt: 'q' }, { maxChars: 10 })).rejects.toThrow(
      /no context budget/,
    );
  });

  it('falls back to default budgets without maxChars or maxChunkChars', async () => {
    const { tool } = setup({ responses: [answer('fine')] });
    const json = await tool.run({ page: 1, prompt: 'q' });
    expect(JSON.parse(json).answer).toBe('fine');
  });
});

describe('abort', () => {
  it('rejects when the signal is already aborted', async () => {
    const { tool, complete } = setup({ responses: [answer('x')] });
    const controller = new AbortController();
    controller.abort();
    await expect(
      tool.run({ page: 1, prompt: 'q' }, { maxChars: 5000, signal: controller.signal }),
    ).rejects.toThrow();
    expect(complete).not.toHaveBeenCalled();
  });

  it('rejects with the abort reason when it is an Error', async () => {
    const { tool } = setup({ responses: [answer('x')] });
    const controller = new AbortController();
    controller.abort(new Error('stop now'));
    await expect(
      tool.run({ page: 1, prompt: 'q' }, { maxChars: 5000, signal: controller.signal }),
    ).rejects.toThrow('stop now');
  });

  it('passes the signal to complete', async () => {
    const { tool, complete } = setup({ responses: [answer('x')] });
    const controller = new AbortController();
    await tool.run({ page: 1, prompt: 'q' }, { maxChars: 5000, signal: controller.signal });
    expect(complete.mock.calls[0][0].signal).toBe(controller.signal);
  });
});

describe('buildPageAgentDataMessage', () => {
  it('flags truncated pages and falls back to the url as title', () => {
    const data = JSON.parse(
      buildPageAgentDataMessage(
        { page: 7, url: 'https://x.test/' },
        ['a', 'b'],
        true,
        'task',
        1000,
      ),
    );
    expect(data.page).toMatchObject({ page: 7, title: 'https://x.test/', truncated: true });
  });
});
