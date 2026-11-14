// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import ChatMessageList from './ChatMessageList.jsx';

let root;
let container;

function render(props) {
  container = document.createElement('div');
  root = createRoot(container);
  act(() => {
    root.render(<ChatMessageList isLoading={false} isLoadingHistory={false} {...props} />);
  });
  return container;
}

function transcript(element) {
  return [...element.querySelectorAll('.pagetollm-chat-message')].map((row) => ({
    speaker: row.querySelector('strong').textContent,
    text: row.querySelector('span').textContent,
  }));
}

afterEach(() => {
  act(() => root.unmount());
});

describe('ChatMessageList', () => {
  it('shows the empty prompt when there are no messages', () => {
    const element = render({ messages: [], emptyPrompt: 'Ask me anything.' });

    expect(element.querySelector('.pagetollm-chat-empty').textContent).toBe('Ask me anything.');
    expect(transcript(element)).toEqual([]);
  });

  it('renders messages in order with speaker labels', () => {
    const element = render({
      messages: [
        { id: 'q1', role: 'user', content: 'What is this about?' },
        { id: 'a1', role: 'assistant', content: 'Answer' },
      ],
    });

    expect(element.querySelector('.pagetollm-chat-empty')).toBeNull();
    expect(transcript(element)).toEqual([
      { speaker: 'You', text: 'What is this about?' },
      { speaker: 'Assistant', text: 'Answer' },
    ]);
  });

  it('appends a thinking row while an answer is loading', () => {
    const element = render({
      messages: [{ id: 'q1', role: 'user', content: 'Hi' }],
      isLoading: true,
      isLoadingHistory: true,
    });

    expect(transcript(element)).toEqual([
      { speaker: 'You', text: 'Hi' },
      { speaker: 'Assistant', text: 'Thinking…' },
    ]);
  });

  it('shows a history loading row instead of the thinking row', () => {
    const element = render({ messages: [], isLoadingHistory: true });

    expect(transcript(element)).toEqual([{ speaker: 'Assistant', text: 'Loading history…' }]);
  });

  it('shows a folded list of the tools an answer called', () => {
    const element = render({
      messages: [
        { id: 'q1', role: 'user', content: 'Q' },
        {
          id: 'a1',
          role: 'assistant',
          content: 'Answer',
          toolLog: [
            { name: 'read_page', args: '{"page":1}', outcome: 'tool_result' },
            { name: 'ask_pages', args: '{}', outcome: 'tool_failed', error: 'Error: boom' },
          ],
        },
      ],
    });

    const details = element.querySelector('.pagetollm-chat-message.is-assistant details');
    expect(details.open).toBe(false);
    expect(details.querySelector('summary').textContent).toBe('Tools called (2)');
    const items = [...details.querySelectorAll('li')];
    expect(
      items.map((item) => item.querySelector('.pagetollm-chat-tool-name').textContent),
    ).toEqual(['read_page', 'ask_pages']);
    expect(items[1].className).toBe('is-failed');
    expect(items[1].title).toBe('Error: boom');
    expect(transcript(element).at(-1)).toEqual({ speaker: 'Assistant', text: 'Answer' });
  });

  it('shows no tool block for answers without tool calls', () => {
    const element = render({ messages: [{ id: 'a1', role: 'assistant', content: 'Answer' }] });
    expect(element.querySelector('details')).toBeNull();
  });

  it('lists tools called so far on the thinking row', () => {
    const element = render({
      messages: [{ id: 'q1', role: 'user', content: 'Hi' }],
      isLoading: true,
      liveToolLog: [{ name: 'search_page', args: '{"query":"x"}', outcome: 'tool_result' }],
    });
    const summary = element.querySelector('.is-loading details summary');
    expect(summary.textContent).toBe('Calling tools (1)');
  });
});
