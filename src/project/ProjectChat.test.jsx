// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toolsMock = vi.hoisted(() => ({
  createProjectChatTools: vi.fn(({ tree }) => ({
    preamble: `Overview of ${tree.runId}`,
    tools: [
      {
        definition: { name: 'search_topics', description: 'Search.', parameters: {} },
        run: async () => '',
      },
    ],
  })),
}));
vi.mock('../core/projects/projectChatTools.js', () => toolsMock);

const { ProjectChat } = await import('./ProjectChat.jsx');

let container;
let root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  toolsMock.createProjectChatTools.mockClear();
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
    getChatLimits: vi.fn(async () => ({ maxChunkChars: 1000, maxHistoryChars: 500 })),
  };
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
}

const pages = [{ title: 'Cat facts' }];
const skipped = [{ title: 'Draft' }];

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
  it('runs a tool-driven turn under the project chat key with no article text', async () => {
    const chatPorts = makePorts();
    const tree = { sourceRevision: 'r1', runId: 'run-1' };
    await render({ tree, eligiblePages: pages, skippedPages: skipped, stale: false, chatPorts });

    expect(toolsMock.createProjectChatTools).toHaveBeenCalledWith({
      tree,
      eligiblePages: pages,
      skippedPages: skipped,
      stale: false,
    });
    expect(chatPorts.chatRepository.list).toHaveBeenCalledWith('project:p1');
    expect(container.textContent).toContain('Ask about this project.');
    expect(container.textContent).not.toContain('Choose topics');
    expect(container.textContent).not.toContain('Whole document');

    await ask('What about cats?');

    const options = chatPorts.runTurn.mock.calls[0][0];
    expect(options.article.sentences).toEqual([]);
    expect(options.article.source).toEqual({ kind: 'project', preamble: 'Overview of run-1' });
    expect(options.tools.map((tool) => tool.definition.name)).toEqual(['search_topics']);
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
  });

  it('rebuilds the tools only when the merge changes', async () => {
    const chatPorts = makePorts();
    const props = { eligiblePages: pages, skippedPages: skipped, stale: false, chatPorts };
    await render({ ...props, tree: { sourceRevision: 'r1', runId: 'run-1' } });
    // A reload of the same merge hands over fresh objects.
    await render({
      ...props,
      tree: { sourceRevision: 'r1', runId: 'run-1' },
      eligiblePages: [...pages],
    });
    expect(toolsMock.createProjectChatTools).toHaveBeenCalledTimes(1);

    await render({ ...props, tree: { sourceRevision: 'r2', runId: 'run-2' } });
    expect(toolsMock.createProjectChatTools).toHaveBeenCalledTimes(2);
  });
});
