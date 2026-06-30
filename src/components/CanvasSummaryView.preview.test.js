// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import {
  buildHighlightedSentencePreviewHtml,
  buildPreviewSourceModel,
  mergeIntervals,
  preserveWhitespaceGaps,
} from './CanvasSummaryView.preview.js';

function parsePreviewHtml(html) {
  const container = document.createElement('div');
  container.innerHTML = html;
  return container;
}

describe('CanvasSummaryView preview helpers', () => {
  it('merges overlapping intervals and preserves whitespace-only gaps', () => {
    expect(
      mergeIntervals([
        { start: 8, end: 10 },
        { start: 0, end: 3 },
        { start: 2, end: 6 },
        { start: 12, end: 12 },
      ]),
    ).toEqual([
      { start: 0, end: 6 },
      { start: 8, end: 10 },
    ]);

    expect(
      preserveWhitespaceGaps(
        [
          { start: 0, end: 5 },
          { start: 8, end: 11 },
        ],
        'Alpha   beta',
      ),
    ).toEqual([{ start: 0, end: 11 }]);

    expect(
      preserveWhitespaceGaps(
        [
          { start: 0, end: 5 },
          { start: 7, end: 11 },
        ],
        'Alpha xbeta',
      ),
    ).toEqual([
      { start: 0, end: 5 },
      { start: 7, end: 11 },
    ]);
  });

  it('builds sentence intervals across the underlying DOM nodes', () => {
    const model = buildPreviewSourceModel(
      '<article><p>Alpha <strong>beta</strong> gamma. Delta epsilon.</p></article>',
      ['Alpha beta gamma.', 'Delta epsilon.'],
    );

    expect(model).not.toBeNull();
    expect(model.sentenceIntervalsByNumber.has(1)).toBe(true);
    expect(model.sentenceIntervalsByNumber.has(2)).toBe(true);

    expect(model.sentenceIntervalsByNumber.get(1)).toEqual([
      { nodeIndex: 0, start: 0, end: 6 },
      { nodeIndex: 1, start: 0, end: 4 },
      { nodeIndex: 2, start: 0, end: 7 },
    ]);
    expect(model.sentenceIntervalsByNumber.get(2)).toEqual([{ nodeIndex: 2, start: 8, end: 22 }]);
  });

  it('returns null when source model inputs or document are unavailable', () => {
    expect(buildPreviewSourceModel('', ['Alpha.'])).toBeNull();
    expect(buildPreviewSourceModel('<p>Alpha.</p>', [])).toBeNull();
    expect(buildPreviewSourceModel('<p>Alpha.</p>', null)).toBeNull();

    const originalDocument = globalThis.document;
    try {
      vi.stubGlobal('document', undefined);
      expect(buildPreviewSourceModel('<p>Alpha.</p>', ['Alpha.'])).toBeNull();
    } finally {
      vi.stubGlobal('document', originalDocument);
    }
  });

  it('renders highlighted preview HTML from context and active sentences', () => {
    const model = buildPreviewSourceModel(
      '<article><p>Alpha <strong>beta</strong> gamma. Delta epsilon.</p></article>',
      ['Alpha beta gamma.', 'Delta epsilon.'],
    );

    const html = buildHighlightedSentencePreviewHtml(model, [0, 1], [1]);
    expect(html).not.toBe('');

    const preview = parsePreviewHtml(html);
    expect(preview.textContent).toContain('Alpha beta gamma.');
    expect(preview.textContent).toContain('Delta epsilon.');
    expect(preview.querySelector('strong')).not.toBeNull();
    expect(preview.querySelectorAll('.canvas-summary-source-preview__highlight')).toHaveLength(1);
    expect(preview.querySelector('.canvas-summary-source-preview__highlight').textContent).toBe(
      'Delta epsilon.',
    );
  });

  it('renders previews when sentence numbers are already one-based', () => {
    const model = buildPreviewSourceModel(
      '<article><p>Alpha beta gamma. Delta epsilon.</p></article>',
      ['Alpha beta gamma.', 'Delta epsilon.'],
    );

    const html = buildHighlightedSentencePreviewHtml(model, [1], [1]);
    expect(html).not.toBe('');

    const preview = parsePreviewHtml(html);
    expect(preview.textContent).toContain('Alpha beta gamma.');
    expect(preview.textContent).not.toContain('Delta epsilon.');
    expect(preview.querySelector('.canvas-summary-source-preview__highlight').textContent).toBe(
      'Alpha beta gamma.',
    );
  });

  it('returns an empty preview for invalid or empty highlight inputs', () => {
    const model = buildPreviewSourceModel('<article><p>Alpha beta.</p></article>', ['Alpha beta.']);

    expect(buildHighlightedSentencePreviewHtml(null, [1], [1])).toBe('');
    expect(buildHighlightedSentencePreviewHtml(model, null, [1])).toBe('');
    expect(buildHighlightedSentencePreviewHtml(model, [1], null)).toBe('');
    expect(buildHighlightedSentencePreviewHtml(model, [], [1])).toBe('');
    expect(buildHighlightedSentencePreviewHtml(model, [99], [99])).toBe('');

    const originalDocument = globalThis.document;
    try {
      vi.stubGlobal('document', undefined);
      expect(buildHighlightedSentencePreviewHtml(model, [1], [1])).toBe('');
    } finally {
      vi.stubGlobal('document', originalDocument);
    }
  });
});
