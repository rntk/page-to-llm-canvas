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
});
