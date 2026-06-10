// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import ErrorDetails from './ErrorDetails.jsx';

function render(element) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(element));
  return {
    container,
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe('ErrorDetails', () => {
  it('renders message only when details is absent', () => {
    const { container, unmount } = render(
      createElement(ErrorDetails, {
        message: 'Something went wrong',
        msgClassName: 'msg-class',
        detailsClassName: 'details-class',
      }),
    );

    const msgEl = container.querySelector('.msg-class');
    expect(msgEl).not.toBeNull();
    expect(msgEl.textContent).toBe('Something went wrong');
    expect(container.querySelector('.details-class')).toBeNull();

    unmount();
  });

  it('renders collapsible details block when details is present', () => {
    const { container, unmount } = render(
      createElement(ErrorDetails, {
        message: 'Something went wrong',
        details: 'stack line 1\nstack line 2',
        msgClassName: 'msg-class',
        detailsClassName: 'details-class',
      }),
    );

    const msgEl = container.querySelector('.msg-class');
    expect(msgEl).not.toBeNull();
    expect(msgEl.textContent).toBe('Something went wrong');

    const detailsEl = container.querySelector('.details-class');
    expect(detailsEl).not.toBeNull();

    const preEl = detailsEl.querySelector('pre');
    expect(preEl).not.toBeNull();
    expect(preEl.textContent).toBe('stack line 1\nstack line 2');

    unmount();
  });
});
