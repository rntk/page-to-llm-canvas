// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { createElement, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import ArticleHtml from './ArticleHtml.jsx';

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

describe('ArticleHtml', () => {
  it('renders HTML content via dangerouslySetInnerHTML', () => {
    const htmlContent = '<div><h1>Test Heading</h1><p>Hello world</p></div>';
    const ref = createRef();
    const { container, unmount } = render(
      createElement(ArticleHtml, {
        html: htmlContent,
        articleTextRef: ref,
      }),
    );

    const heading = container.querySelector('h1');
    expect(heading).not.toBeNull();
    expect(heading.textContent).toBe('Test Heading');

    const paragraph = container.querySelector('p');
    expect(paragraph).not.toBeNull();
    expect(paragraph.textContent).toBe('Hello world');

    unmount();
  });

  it('correctly forwards the ref to the outer div element', () => {
    const htmlContent = '<div>Test</div>';
    const ref = createRef();
    const { container, unmount } = render(
      createElement(ArticleHtml, {
        html: htmlContent,
        articleTextRef: ref,
      }),
    );

    expect(ref.current).not.toBeNull();
    expect(ref.current.tagName.toLowerCase()).toBe('div');
    expect(ref.current.classList.contains('pagetollm-article-text')).toBe(true);
    expect(ref.current.classList.contains('pagetollm-article-html')).toBe(true);

    unmount();
  });
});
