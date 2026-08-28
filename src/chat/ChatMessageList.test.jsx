// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

import ChatMessageList from './ChatMessageList.jsx';

describe('ChatMessageList', () => {
  it('does not render the transcript again when its props are unchanged', () => {
    const readContent = vi.fn(() => 'Answer');
    const message = { id: 'answer-1', role: 'assistant' };
    Object.defineProperty(message, 'content', { get: readContent });
    const messages = [message];
    const container = document.createElement('div');
    const root = createRoot(container);

    act(() => {
      root.render(
        <ChatMessageList messages={messages} isLoading={false} isLoadingHistory={false} />,
      );
    });
    expect(readContent).toHaveBeenCalledTimes(1);

    act(() => {
      root.render(
        <ChatMessageList messages={messages} isLoading={false} isLoadingHistory={false} />,
      );
    });
    expect(readContent).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
  });
});
