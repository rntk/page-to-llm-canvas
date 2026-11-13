// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toolsMock = vi.hoisted(() => ({
  createProjectChatContext: vi.fn((tree) => {
    const tools = [
      {
        definition: { name: 'search_topics', description: 'Search.', parameters: {} },
        run: async () => '',
      },
    ];
    return {
      tools,
      buildPreamble: vi.fn(
        ({ skippedPages = [], stale = false } = {}) =>
          `Overview of ${tree.runId}${stale ? ' (stale)' : ''} skipped: ${skippedPages
            .map((page) => page.title)
            .join(',')}`,
      ),
    };
  }),
}));
vi.mock('../core/projects/projectChatTools.js', () => toolsMock);

const { ProjectChat } = await import('./ProjectChat.jsx');
const { MSG } = await import('../shared/runtime/messages.js');

let container;
let root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  toolsMock.createProjectChatContext.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

function makePorts() {
  return {
    chatRepository: {
      list: vi.fn(async () => []),
      get: vi.fn(),
      append: vi.fn(async (key, chatId, turn) => ({
        chat: { chatId: 'chat-1', messages: turn.messages, events: [], scope: [] },
      })),
      remove: vi.fn(),
    },
    runTurn: vi.fn(async () => ({ reply: 'Answer', highlightRanges: [] })),
    getChatLimits: vi.fn(async () => ({ maxChunkChars: 20000, maxHistoryChars: 5000 })),
  };
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
}

const eligible = [{ title: 'Cat facts' }];
const skipped = [{ title: 'Draft' }];
const pages = [
  { page: 1, title: 'Cat facts', url: 'https://cats.test/' },
  { page: 2, title: 'Dog facts', url: 'https://dogs.test/' },
];

function makeDeps() {
  return {
    pages,
    readPage: vi.fn(async () => ({ sentences: ['Cats purr.'], truncated: false, topics: [] })),
    send: vi.fn(async (message) => {
      if (message.type === MSG.getProjectChatScanConfig) return { ok: true, mode: 'llm' };
      if (message.type === MSG.llmChatCompletion) {
        return { ok: true, content: JSON.stringify({ relevance: 'none' }) };
      }
      return { ok: true };
    }),
  };
}

async function render(props) {
  await act(async () => root.render(<ProjectChat projectId="p1" {...props} />));
  await flush();
}

async function ask(question) {
  const textarea = container.querySelector('textarea');
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(textarea, question);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  await flush();
}

describe('ProjectChat', () => {
  it('runs a page-tool turn under the project chat key with no article text, without a tree', async () => {
    const chatPorts = makePorts();
    const deps = makeDeps();
    await render({ ...deps, chatPorts });

    expect(toolsMock.createProjectChatContext).not.toHaveBeenCalled();
    expect(chatPorts.chatRepository.list).toHaveBeenCalledWith('project:p1');
    expect(container.textContent).toContain('Ask about this project’s pages.');
    expect(container.textContent).toContain('checks each page for relevance');
    expect(container.textContent).not.toContain('Choose topics');
    expect(container.textContent).not.toContain('Whole document');

    await ask('What about cats?');

    const options = chatPorts.runTurn.mock.calls[0][0];
    expect(options.article.sentences).toEqual([]);
    expect(options.article.source.kind).toBe('project');
    expect(options.article.source.preamble).toContain('Cat facts');
    expect(options.article.source.preamble).toContain('Dog facts');
    expect(options.tools.map((tool) => tool.definition.name)).toEqual([
      'read_page',
      'search_page',
      'ask_pages',
    ]);
    // First message: both pages were scanned by the completion LLM.
    expect(deps.readPage).toHaveBeenCalledTimes(2);
    expect(deps.send.mock.calls.filter(([m]) => m.type === MSG.llmChatCompletion)).toHaveLength(2);
    expect(chatPorts.chatRepository.append).toHaveBeenCalledWith(
      'project:p1',
      null,
      expect.objectContaining({
        messages: [
          { role: 'user', content: 'What about cats?' },
          { role: 'assistant', content: 'Answer' },
        ],
        events: [],
      }),
      expect.anything(),
    );
    expect(container.textContent).toContain('Answer');
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it('shows scan progress while the pages are checked, then clears it', async () => {
    const chatPorts = makePorts();
    const deps = makeDeps();
    const releases = [];
    deps.readPage = vi.fn(
      () =>
        new Promise((resolve) => {
          releases.push(() => resolve({ sentences: ['Cats purr.'] }));
        }),
    );
    await render({ ...deps, chatPorts });
    await ask('What about cats?');
    const status = container.querySelector('[role="status"]');
    expect(status.textContent).toBe('Checking pages for relevance… 0/2');
    expect(chatPorts.runTurn).not.toHaveBeenCalled();

    await act(async () => releases.forEach((release) => release()));
    await flush();
    expect(chatPorts.runTurn).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it('adds the merged-tree tools and overview only when a tree is given', async () => {
    const chatPorts = makePorts();
    const tree = { sourceRevision: 'r1', runId: 'run-1' };
    await render({
      ...makeDeps(),
      tree,
      eligiblePages: eligible,
      skippedPages: skipped,
      stale: false,
      chatPorts,
    });
    expect(toolsMock.createProjectChatContext).toHaveBeenCalledWith(tree);
    await ask('What about cats?');

    const options = chatPorts.runTurn.mock.calls[0][0];
    expect(options.article.source.preamble).toContain('Overview of run-1 skipped: Draft');
    expect(options.tools.map((tool) => tool.definition.name)).toEqual([
      'read_page',
      'search_page',
      'ask_pages',
      'search_topics',
    ]);
  });

  it('scans again on a follow-up question, with its own per-turn page reads', async () => {
    const chatPorts = makePorts();
    chatPorts.chatRepository.get = vi.fn();
    const deps = makeDeps();
    await render({ ...deps, chatPorts });
    await ask('First?');
    const first = deps.send.mock.calls.length;
    expect(first).toBeGreaterThan(0);
    // The saved turn is now the chat's history.
    chatPorts.runTurn.mockClear();
    await ask('Second?');
    const options = chatPorts.runTurn.mock.calls[0][0];
    expect(options.article.history).toHaveLength(2);
    expect(options.tools.map((tool) => tool.definition.name)).toContain('ask_pages');
    expect(deps.send).toHaveBeenCalledTimes(first * 2);
    expect(deps.readPage).toHaveBeenCalledTimes(4);
  });

  it('rebuilds the tree tools only when the merge changes', async () => {
    const chatPorts = makePorts();
    const props = {
      ...makeDeps(),
      eligiblePages: eligible,
      skippedPages: skipped,
      stale: false,
      chatPorts,
    };
    const tree = { sourceRevision: 'r1', runId: 'run-1' };
    await render({ ...props, tree });
    // useProjectView hands an unchanged merge back as the same objects.
    await render({ ...props, tree, stale: true });
    expect(toolsMock.createProjectChatContext).toHaveBeenCalledTimes(1);

    await render({ ...props, tree: { sourceRevision: 'r2', runId: 'run-2' } });
    expect(toolsMock.createProjectChatContext).toHaveBeenCalledTimes(2);
  });

  it('updates the tree overview when a skipped page is swapped, keeping the tree tools', async () => {
    const chatPorts = makePorts();
    const tree = { sourceRevision: 'r1', runId: 'run-1' };
    const props = { ...makeDeps(), tree, eligiblePages: eligible, stale: false, chatPorts };
    await render({ ...props, skippedPages: [{ title: 'Draft', url: 'https://d.test/' }] });
    await ask('First?');
    await render({
      ...props,
      skippedPages: [{ title: 'Other draft', url: 'https://o.test/' }],
    });
    await ask('Second?');

    const [first, second] = chatPorts.runTurn.mock.calls.map(([options]) => options);
    expect(first.article.source.preamble).toContain('Overview of run-1 skipped: Draft');
    expect(second.article.source.preamble).toContain('Overview of run-1 skipped: Other draft');
    expect(second.tools.at(-1)).toBe(first.tools.at(-1));
    expect(toolsMock.createProjectChatContext).toHaveBeenCalledTimes(1);
  });

  it('keeps the runner for equal page content and refreshes the overview when staleness flips', async () => {
    const chatPorts = makePorts();
    const tree = { sourceRevision: 'r1', runId: 'run-1' };
    const props = { ...makeDeps(), tree, eligiblePages: eligible, chatPorts, stale: false };
    await render({ ...props, skippedPages: skipped });
    await render({ ...props, skippedPages: skipped });
    await ask('One?');
    await render({ ...props, skippedPages: skipped, stale: true });
    await ask('Two?');
    const [first, second] = chatPorts.runTurn.mock.calls.map(([options]) => options);
    expect(first.article.source.preamble).toContain('Overview of run-1 skipped: Draft');
    expect(second.article.source.preamble).toContain('Overview of run-1 (stale) skipped: Draft');
  });

  it('saves page highlight events and hands painted ones to onHighlight', async () => {
    const chatPorts = makePorts();
    const highlight = {
      startLine: 2,
      endLine: 3,
      label: 'Purring',
      page: 1,
      pageUrl: 'https://cats.test/',
      pageTitle: 'Cat facts',
      excerpt: ['Cats purr when happy.', 'They purr when hurt too.'],
    };
    chatPorts.runTurn.mockResolvedValue({ reply: 'Answer', highlightRanges: [highlight] });
    chatPorts.chatRepository.append.mockImplementation(async (key, chatId, turn) => ({
      chat: {
        chatId: 'chat-1',
        messages: turn.messages,
        events: turn.events.map((event, i) => ({ ...event, seq: i + 1, turnId: turn.turnId })),
        scope: [],
      },
    }));
    const deps = makeDeps();
    const onHighlight = vi.fn();
    const onClearHighlights = vi.fn();
    await render({ ...deps, chatPorts, onHighlight, onClearHighlights });
    await ask('Why do cats purr?');

    // The saved turn is painted: its page highlight goes to the canvas.
    expect(onClearHighlights).toHaveBeenCalled();
    expect(onHighlight).toHaveBeenLastCalledWith(highlight);
    const call = chatPorts.chatRepository.append.mock.calls[0][2];
    expect(call.events).toEqual([{ eventType: 'highlight_span', data: highlight }]);
    const eventsTab = [...container.querySelectorAll('[role=tab]')].find((tab) =>
      tab.textContent.startsWith('Events'),
    );
    await act(async () => eventsTab.click());
    const event = container.querySelector('.pagetollm-chat-event button');
    expect(event.textContent).toContain('Cat facts · Lines 2–3');
    // The excerpt itself is shown on the canvas, not in the chat.
    expect(container.textContent).not.toContain('Cats purr when happy.');

    await act(async () => event.click());
    await flush();
    expect(onHighlight).toHaveBeenLastCalledWith(highlight, { focus: true });
  });
});
