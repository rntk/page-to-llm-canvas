import { describe, expect, it, vi } from 'vitest';
import { LLM_TASK_TYPES } from '../core/metrics/llm.js';
import { MSG } from '../shared/runtime/messages.js';
import {
  createProjectChatTurnRunner,
  earlierUserQuestions,
  projectChatBudgets,
  SCAN_PHASE,
} from './projectChatTurn.js';

const pages = [
  { page: 1, title: 'Cats', url: 'https://cats.test/' },
  { page: 2, title: 'Dogs', url: 'https://dogs.test/' },
];
const texts = {
  'https://cats.test/': ['Cats purr when happy.', 'Cats sleep a lot.'],
  'https://dogs.test/': ['Dogs bark.', 'Dogs fetch sticks.'],
};

const llmReply = (verdict) => ({ ok: true, content: JSON.stringify(verdict) });
const helps = (p) => ({
  choice: p >= 0.5 ? 'helps_answer' : 'unrelated',
  probabilities: { helps_answer: p, unrelated: Math.round((1 - p) * 1e6) / 1e6 },
});
const decisionAnswers = (questions, p) =>
  Object.fromEntries(Object.keys(questions).map((id) => [id, helps(p)]));

/** A transport answering config, completion, decision and cancel requests. */
function makeSend({ config = { ok: true, mode: 'llm' }, complete, decide } = {}) {
  return vi.fn(async (message) => {
    switch (message.type) {
      case MSG.getProjectChatScanConfig:
        if (config instanceof Error) throw config;
        return config;
      case MSG.llmChatCompletion:
        return (
          complete?.(message) ??
          llmReply({
            relevance: 'high',
            summary: 'Covers purring.',
            findings: [{ start_line: 1, end_line: 1, note: 'purring' }],
          })
        );
      case MSG.projectChatDecide:
        return decide
          ? decide(message)
          : { ok: true, answers: decisionAnswers(message.questions, 0.9) };
      default:
        return { ok: true };
    }
  });
}

function setup({
  send = makeSend(),
  readPage = vi.fn(async (url) => ({ sentences: texts[url], truncated: false, topics: ['Pets'] })),
  runTurn = vi.fn(async () => ({ reply: 'Answer', highlightRanges: [] })),
  ...rest
} = {}) {
  const onScanProgress = vi.fn();
  const run = createProjectChatTurnRunner({
    pages,
    readPage,
    getScanConfig: () => send({ type: MSG.getProjectChatScanConfig }),
    send,
    runTurn,
    onScanProgress,
    ...rest,
  });
  return { run, send, readPage, runTurn, onScanProgress };
}

const options = (overrides = {}) => ({
  article: { history: [], sentences: [], highlightedRanges: [] },
  question: 'Why do cats purr?',
  limits: { maxChunkChars: 20_000, maxHistoryChars: 5000 },
  runtime: { turnId: 'turn-1', signal: new AbortController().signal },
  effects: {},
  ...overrides,
});

const toolNames = (call) => call.tools.map((tool) => tool.definition.name);
const sentTypes = (send, type) => send.mock.calls.filter(([m]) => m.type === type).map(([m]) => m);

describe('createProjectChatTurnRunner', () => {
  it('rejects an oversized question before any scan work', async () => {
    const { run, readPage, send, runTurn, onScanProgress } = setup();
    await expect(
      run(
        options({
          question: 'x'.repeat(1745),
          limits: { maxChunkChars: 1000, maxHistoryChars: 1000 },
        }),
      ),
    ).rejects.toThrow('This question is too long');
    expect(readPage).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(runTurn).not.toHaveBeenCalled();
    expect(onScanProgress).not.toHaveBeenCalled();
  });

  it('allows a question at the source budget boundary using the history allowance', async () => {
    const { run, readPage, runTurn } = setup();
    await run(
      options({
        question: 'x'.repeat(1616),
        limits: { maxChunkChars: 1000, maxHistoryChars: 1000 },
      }),
    );
    expect(readPage).toHaveBeenCalledTimes(2);
    expect(runTurn).toHaveBeenCalledTimes(1);
  });

  it('scans every page on the first message and puts the results in the overview', async () => {
    const { run, runTurn, send, readPage, onScanProgress } = setup();
    const opts = options();
    const result = await run(opts);

    expect(result).toBe(await runTurn.mock.results[0].value);
    const call = runTurn.mock.calls[0][0];
    expect(call.article.source.kind).toBe('project');
    expect(call.article.source.preamble).toContain('Covers purring.');
    expect(call.article.source.preamble).toContain('Cats');
    expect(call.article.source.preamble).toContain('language model');
    expect(toolNames(call)).toEqual(['read_page', 'search_page', 'ask_pages', 'ask_page_agent']);
    // Everything else is passed through untouched.
    expect(call.question).toBe(opts.question);
    expect(call.limits).toBe(opts.limits);
    expect(call.effects).toBe(opts.effects);
    expect(call.runtime.signal).toBe(opts.runtime.signal);

    const completions = sentTypes(send, MSG.llmChatCompletion);
    expect(completions).toHaveLength(2);
    expect(completions[0]).toMatchObject({
      taskType: LLM_TASK_TYPES.CHAT_PAGE_SCAN,
      chatTurnId: 'turn-1',
    });
    expect(readPage).toHaveBeenCalledTimes(2);
    expect(sentTypes(send, MSG.getProjectChatScanConfig)).toHaveLength(1);

    const reports = onScanProgress.mock.calls.map(([progress]) => progress);
    expect(reports[0]).toEqual({ phase: SCAN_PHASE, done: 0, total: 2 });
    expect(reports).toContainEqual({ phase: SCAN_PHASE, done: 2, total: 2 });
    expect(reports.at(-1)).toBeNull();
  });

  it('scans on a follow-up turn with the earlier question; ask_pages shares the per-turn cache', async () => {
    const { run, runTurn, send, readPage, onScanProgress } = setup();
    await run(
      options({
        article: {
          history: [
            { role: 'user', content: 'Earlier?' },
            { role: 'assistant', content: 'Earlier.' },
          ],
        },
      }),
    );
    const call = runTurn.mock.calls[0][0];
    expect(readPage).toHaveBeenCalledTimes(2);
    expect(onScanProgress).toHaveBeenCalled();
    const scanRequests = sentTypes(send, MSG.llmChatCompletion);
    expect(scanRequests).toHaveLength(2);
    for (const request of scanRequests) {
      expect(JSON.parse(request.messages.at(-1).content)).toEqual({
        kind: 'question',
        text: 'Why do cats purr?',
        earlier_questions: ['Earlier?'],
      });
    }
    expect(call.article.source.preamble).toContain('PAGE SCAN\nProduced for the current message');
    expect(toolNames(call)).toContain('ask_pages');

    const askPages = call.tools.find((tool) => tool.definition.name === 'ask_pages');
    const reply = JSON.parse(
      await askPages.run({ question: 'What about dogs?', pages: [2] }, { maxChars: 4000 }),
    );
    expect(reply.pagesScanned).toBe(1);
    expect(sentTypes(send, MSG.llmChatCompletion)).toHaveLength(3);
    // The scan already read both pages this turn, so ask_pages reuses them.
    expect(readPage).toHaveBeenCalledTimes(2);
    expect(onScanProgress.mock.calls.at(-1)).toEqual([null]);
    expect(sentTypes(send, MSG.llmChatCompletion)[2].chatTurnId).toBe('turn-1');
  });

  it('sends earlier questions to the decision judge state too', async () => {
    const send = makeSend({ config: { ok: true, mode: 'decision', contextWindowTokens: 16_000 } });
    const { run } = setup({ send });
    await run(options({ article: { history: [{ role: 'user', content: 'What is a cat?' }] } }));
    const decisions = sentTypes(send, MSG.projectChatDecide);
    expect(decisions.length).toBe(2);
    expect(decisions[0].state.earlier_questions).toEqual(['What is a cat?']);
  });

  it('uses the decision provider when selected, and a failed request marks the page unknown', async () => {
    const decide = vi.fn((message) =>
      message.state.page_title === 'Dogs'
        ? { ok: false, error: 'provider down' }
        : { ok: true, answers: decisionAnswers(message.questions, 0.9) },
    );
    const send = makeSend({
      config: { ok: true, mode: 'decision', contextWindowTokens: 16_000 },
      decide,
    });
    const { run, runTurn } = setup({ send });
    await run(options());

    expect(sentTypes(send, MSG.llmChatCompletion)).toHaveLength(0);
    const decisions = sentTypes(send, MSG.projectChatDecide);
    expect(decisions.length).toBe(2);
    expect(decisions.every((m) => m.chatTurnId === 'turn-1')).toBe(true);
    const preamble = runTurn.mock.calls[0][0].article.source.preamble;
    expect(preamble).toContain('decision');
    expect(preamble).toMatch(/Dogs|2/);
    expect(preamble).toContain('provider down');
    // The turn went on and the successful page is reported.
    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(preamble).toContain('Cats');
  });

  it.each([
    ['rejects', new Error('no worker')],
    ['answers not ok', { ok: false, error: 'bad' }],
    ['names an unknown mode', { ok: true, mode: 'other' }],
  ])('falls back to the completion LLM when the scan config %s', async (_name, config) => {
    const send = makeSend({ config });
    const { run, runTurn } = setup({ send });
    await run(options());
    expect(sentTypes(send, MSG.llmChatCompletion)).toHaveLength(2);
    expect(sentTypes(send, MSG.projectChatDecide)).toHaveLength(0);
    expect(runTurn).toHaveBeenCalledTimes(1);
  });

  it('reads each page once per turn across the scan and the tools, but not across turns', async () => {
    const { run, runTurn, readPage } = setup();
    await run(options());
    const call = runTurn.mock.calls[0][0];
    const byName = Object.fromEntries(call.tools.map((tool) => [tool.definition.name, tool]));
    await byName.read_page.run({ page: 1 }, { maxChars: 4000 });
    await byName.search_page.run({ query: 'cats' }, { maxChars: 4000 });
    await byName.ask_pages.run({ question: 'More?' }, { maxChars: 4000 });
    expect(readPage).toHaveBeenCalledTimes(2);

    await run(options());
    expect(readPage).toHaveBeenCalledTimes(4);
  });

  it('offers ask_page_agent, which sends helper requests with the turn id and shares the turn page cache', async () => {
    const send = makeSend({
      complete: (message) =>
        message.taskType === 'chat_page_agent' ? { ok: true, content: 'done' } : undefined,
    });
    const { run, runTurn, readPage } = setup({ send });
    await run(options());
    const call = runTurn.mock.calls[0][0];
    expect(readPage).toHaveBeenCalledTimes(2);

    const agent = call.tools.find((tool) => tool.definition.name === 'ask_page_agent');
    const reply = JSON.parse(await agent.run({ page: 1, prompt: 'Summarise' }, { maxChars: 4000 }));
    expect(reply).toMatchObject({ kind: 'page_agent_answer', page: 1, answer: 'done' });

    const helperRequests = sentTypes(send, MSG.llmChatCompletion).filter(
      (m) => m.taskType === 'chat_page_agent',
    );
    expect(helperRequests).toHaveLength(1);
    expect(helperRequests[0]).toEqual({
      type: MSG.llmChatCompletion,
      taskType: 'chat_page_agent',
      chatTurnId: 'turn-1',
      messages: expect.any(Array),
      tools: expect.any(Array),
    });
    // The scan already read both pages this turn, so the helper reuses them.
    expect(readPage).toHaveBeenCalledTimes(2);
  });

  it('offers a page highlight tool that shares the turn page cache', async () => {
    const { run, runTurn, readPage } = setup();
    await run(options());
    const { highlightTool } = runTurn.mock.calls[0][0];
    expect(highlightTool.definition.name).toBe('highlight_span');
    const range = await highlightTool.resolve({ page: 1, start_line: 1, end_line: 2 });
    expect(range).toMatchObject({
      page: 1,
      pageUrl: 'https://cats.test/',
      pageTitle: 'Cats',
      excerpt: ['Cats purr when happy.', 'Cats sleep a lot.'],
    });
    // The first-message scan already read both pages.
    expect(readPage).toHaveBeenCalledTimes(2);
  });

  it('retries a failed read later in the same turn', async () => {
    let calls = 0;
    const readPage = vi.fn(async (url) => {
      calls += 1;
      if (calls === 1) throw new Error('capture failed');
      return { sentences: texts[url] };
    });
    const { run, runTurn } = setup({ readPage });
    await run(options());
    const preamble = runTurn.mock.calls[0][0].article.source.preamble;
    expect(preamble).toContain('capture failed');
    const readTool = runTurn.mock.calls[0][0].tools.find((t) => t.definition.name === 'read_page');
    const failedPage = pages.find((page) => readPage.mock.calls[0][0] === page.url).page;
    const reply = JSON.parse(await readTool.run({ page: failedPage }, { maxChars: 4000 }));
    expect(reply.kind).toBe('page_text');
    expect(readPage).toHaveBeenCalledTimes(3);
  });

  it('propagates an abort during the scan, cancels the requests and clears progress', async () => {
    const controller = new AbortController();
    const send = makeSend({
      complete: () => {
        controller.abort();
        return new Promise(() => {});
      },
    });
    const { run, runTurn, onScanProgress } = setup({ send });
    await expect(
      run(options({ runtime: { turnId: 'turn-9', signal: controller.signal } })),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(runTurn).not.toHaveBeenCalled();
    expect(onScanProgress.mock.calls.at(-1)).toEqual([null]);
    expect(send).toHaveBeenCalledWith({ type: MSG.cancelChatTurn, turnId: 'turn-9' });
  });

  it('rejects at once when the turn is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { run, runTurn, send } = setup();
    await expect(
      run(options({ runtime: { turnId: 't', signal: controller.signal } })),
    ).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(send).not.toHaveBeenCalled();
    expect(runTurn).not.toHaveBeenCalled();
  });

  it('lets the wrapped runner abort propagate unchanged', async () => {
    const abort = Object.assign(new Error('The chat turn was cancelled.'), { name: 'AbortError' });
    const { run } = setup({ runTurn: vi.fn(async () => Promise.reject(abort)) });
    await expect(run(options())).rejects.toBe(abort);
  });

  it('adds the merged-tree tools and overview only when a tree context is given', async () => {
    const without = setup();
    await without.run(options());
    expect(toolNames(without.runTurn.mock.calls[0][0])).not.toContain('search_topics');
    expect(without.runTurn.mock.calls[0][0].article.source.preamble).toContain(
      'Not available in this chat',
    );

    const treeContext = {
      tools: [{ definition: { name: 'search_topics' }, run: async () => '' }],
      buildPreamble: vi.fn(() => 'TREE-OVERVIEW-TEXT'),
    };
    const treeOverviewInput = { eligiblePages: [{ title: 'Cats' }], skippedPages: [], stale: true };
    const withTree = setup({ treeContext, treeOverviewInput });
    await withTree.run(options());
    const call = withTree.runTurn.mock.calls[0][0];
    expect(toolNames(call)).toEqual([
      'read_page',
      'search_page',
      'ask_pages',
      'ask_page_agent',
      'search_topics',
    ]);
    expect(call.article.source.preamble).toContain('TREE-OVERVIEW-TEXT');
    expect(treeContext.buildPreamble).toHaveBeenCalledWith({
      ...treeOverviewInput,
      preambleMaxChars: expect.any(Number),
    });
  });

  it('still runs the turn with no readable pages, without scanning', async () => {
    const { run, runTurn, send } = setup({
      pages: [],
      unreadablePages: [{ title: 'Settings', url: 'chrome://settings', reason: 'Not readable.' }],
    });
    await run(options());
    expect(send).not.toHaveBeenCalled();
    const call = runTurn.mock.calls[0][0];
    expect(call.article.source.preamble).toContain('this project has no pages');
    expect(call.article.source.preamble).toContain('Settings');
  });

  it('creates a turn id when none is given and forwards it', async () => {
    const { run, runTurn, send } = setup();
    await run(options({ runtime: {} }));
    const { turnId } = runTurn.mock.calls[0][0].runtime;
    expect(turnId).toEqual(expect.any(String));
    expect(sentTypes(send, MSG.llmChatCompletion)[0].chatTurnId).toBe(turnId);
  });

  it('keeps the overview within half of the chunk budget, scan text taking about half of that', async () => {
    const many = Array.from({ length: 40 }, (_, index) => ({
      page: index + 1,
      title: `Page ${index + 1} about cats and other pets`,
      url: `https://p${index + 1}.test/`,
    }));
    const send = makeSend({
      complete: () =>
        llmReply({
          relevance: 'high',
          summary: 'x'.repeat(250),
          findings: [{ start_line: 1, end_line: 1, note: 'y'.repeat(150) }],
        }),
    });
    const { run, runTurn } = setup({
      send,
      pages: many,
      readPage: vi.fn(async () => ({ sentences: ['One.', 'Two.'] })),
    });
    await run(options({ limits: { maxChunkChars: 6000, maxHistoryChars: 2000 } }));
    const { preamble } = runTurn.mock.calls[0][0].article.source;
    expect(preamble.length).toBeLessThanOrEqual(3000);
    expect(preamble).toContain('PAGE SCAN');
  });

  it('requires a page reader and a transport', () => {
    expect(() => createProjectChatTurnRunner({ send: vi.fn() })).toThrow('readPage');
    expect(() => createProjectChatTurnRunner({ readPage: vi.fn() })).toThrow('send');
  });
});

describe('projectChatBudgets', () => {
  it('derives the overview from half the chunk budget less the question, giving the scan 70% of it', () => {
    const { overviewChars, scanChars, treeChars, scanChunkChars } = projectChatBudgets(
      20_000,
      'x'.repeat(100),
    );
    expect(overviewChars).toBeLessThanOrEqual(9950);
    expect(overviewChars).toBeGreaterThan(9000);
    expect(scanChars).toBe(Math.floor(overviewChars * 0.7));
    expect(treeChars).toBe(Math.floor(overviewChars * 0.25));
    expect(scanChunkChars).toBe(19_900);
  });

  it('falls back to the default chunk size without a usable limit', () => {
    expect(projectChatBudgets(undefined, '').overviewChars).toBeGreaterThan(1000);
  });
});

describe('earlierUserQuestions', () => {
  it('keeps only the last 3 user messages, oldest first', () => {
    const history = [
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'reply one' },
      { role: 'user', content: 'two' },
      { role: 'user', content: 'three' },
      { role: 'assistant', content: 'reply three' },
      { role: 'user', content: 'four' },
    ];
    expect(earlierUserQuestions(history)).toEqual(['two', 'three', 'four']);
  });

  it('collapses whitespace, clips to 300 characters and skips empty or non-string messages', () => {
    const history = [
      { role: 'user', content: '  a \n\n  b\tc  ' },
      { role: 'user', content: '   ' },
      { role: 'user', content: { text: 'not a string' } },
      { role: 'user', content: 'x'.repeat(500) },
    ];
    const [first, second] = earlierUserQuestions(history);
    expect(first).toBe('a b c');
    expect(second).toHaveLength(300);
    expect(second.endsWith('…')).toBe(true);
  });

  it('returns an empty list without usable history', () => {
    expect(earlierUserQuestions(undefined)).toEqual([]);
    expect(earlierUserQuestions('nope')).toEqual([]);
    expect(earlierUserQuestions([])).toEqual([]);
  });
});
