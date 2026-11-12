// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ChatComposer from './ChatComposer.jsx';

let container;
let root;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

it('sends on Enter but leaves composition confirmation and Shift+Enter alone', () => {
  const onSend = vi.fn();
  act(() => root.render(<ChatComposer value="message" onChange={() => {}} onSend={onSend} />));
  const textarea = container.querySelector('textarea');
  const press = (options) => {
    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
      ...options,
    });
    act(() => textarea.dispatchEvent(event));
    return event;
  };
  expect(press({ isComposing: true }).defaultPrevented).toBe(false);
  expect(press({ keyCode: 229 }).defaultPrevented).toBe(false);
  expect(press({ shiftKey: true }).defaultPrevented).toBe(false);
  expect(onSend).not.toHaveBeenCalled();
  expect(press({}).defaultPrevented).toBe(true);
  expect(onSend).toHaveBeenCalledTimes(1);
});
