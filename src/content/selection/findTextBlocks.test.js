// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findTextBlocks, measureTextMass } from './findTextBlocks.js';

function prose(character, length) {
  return `${character.repeat(length)}.`;
}

function append(tag, text = '', parent = document.body) {
  const element = document.createElement(tag);
  element.textContent = text;
  parent.appendChild(element);
  return element;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('measureTextMass', () => {
  it('counts normalized multilingual characters and link text once', async () => {
    const article = append('article');
    article.append('  日本語\n\n本文  ');
    const link = append('a', ' linked   words ', article);
    link.href = '/more';

    const { metrics } = await measureTextMass(document);
    expect(metrics.get(article)).toEqual({ mass: 18, linkMass: 12 });
  });

  it('zeros hidden, steering-noise, selected, and extension-owned subtrees', async () => {
    const article = append('article', prose('a', 100));
    const hidden = append('div', prose('h', 100));
    hidden.hidden = true;
    const nav = append('nav', prose('n', 100));
    const selected = append('section', prose('s', 100));
    const toolbar = append('div', prose('t', 100));
    toolbar.id = 'pagetollm-selection-toolbar';

    const result = await measureTextMass(document, { selected: [selected] });
    expect(result.metrics.get(document.body).mass).toBe(result.metrics.get(article).mass);
    expect(result.metrics.get(hidden).mass).toBe(0);
    expect(result.metrics.get(nav).mass).toBe(0);
    expect(result.metrics.get(selected).mass).toBe(0);
    expect(result.metrics.get(toolbar).mass).toBe(0);
  });

  it('keeps visibility-restored descendants and skips closed details content', async () => {
    const hidden = append('div');
    hidden.style.visibility = 'hidden';
    hidden.append('invisible');
    const restored = append('p', prose('v', 40), hidden);
    restored.style.visibility = 'visible';
    const details = append('details');
    append('summary', prose('s', 10), details);
    append('p', prose('x', 80), details);

    const { metrics } = await measureTextMass(document);
    expect(metrics.get(hidden).mass).toBe(41);
    expect(metrics.get(details).mass).toBe(11);
  });

  it('yields in batches and reports budgets without partial results', async () => {
    const article = append('article');
    for (let index = 0; index < 8; index += 1) append('p', prose('x', 20), article);
    const timeout = vi.spyOn(document.defaultView, 'setTimeout');
    const measured = await measureTextMass(document, { batchSize: 2 });
    expect(measured.status).toBe('complete');
    expect(timeout).toHaveBeenCalled();
    const incomplete = await measureTextMass(document, { maxNodes: 2 });
    expect(incomplete.status).toBe('incomplete');
  });

  it('budgets direct text nodes and honors suppressed document ancestors', async () => {
    const article = append('article');
    article.append(document.createComment('ordinary comment'));
    for (let index = 0; index < 100; index += 1) article.append(`text ${index} `);
    expect((await measureTextMass(document, { maxNodes: 5 })).status).toBe('incomplete');

    document.documentElement.style.opacity = '0';
    try {
      const hidden = await measureTextMass(document, { maxNodes: 1_000 });
      expect(hidden.metrics.get(document.body).mass).toBe(0);
    } finally {
      document.documentElement.style.opacity = '';
    }
  });
});

describe('findTextBlocks', () => {
  const detectorOptions = { minMass: 80, maxTimeMs: 10_000 };

  it('descends through wrappers to a semantic article and ignores surrounding noise', async () => {
    append('nav', prose('n', 300));
    const main = append('main');
    const wrapper = append('div', '', main);
    const article = append('article', prose('a', 300), wrapper);
    append('aside', prose('s', 300), main);

    const result = await findTextBlocks(document, detectorOptions);
    expect(result.status).toBe('found');
    expect(result.blocks.map((block) => block.element)).toEqual([article]);
    expect(result.trace.path.length).toBeGreaterThan(0);
  });

  it('trims the body direct children and never returns body or html when descent stops at body', async () => {
    const first = append('section', prose('a', 200));
    const second = append('section', prose('b', 190));
    const third = append('section', prose('c', 180));

    const result = await findTextBlocks(document, detectorOptions);
    expect(result.status).toBe('found');
    expect(result.blocks.map((block) => block.element)).toEqual([first, second, third]);
    const elements = result.blocks.map((block) => block.element);
    expect(elements).not.toContain(document.body);
    expect(elements).not.toContain(document.documentElement);
  });

  it('returns article sections around a tiny ad in DOM order', async () => {
    const article = append('article');
    const first = append('section', prose('a', 150), article);
    append('div', 'ad', article);
    const second = append('section', prose('b', 140), article);

    const result = await findTextBlocks(document, detectorOptions);
    expect(result.status).toBe('found');
    expect(result.blocks.map((block) => block.element)).toEqual([first, second]);
    expect(result.trace.result.mass).toBeGreaterThan(280);
  });

  it('joins many prose paragraphs around a tiny ad into their article root', async () => {
    const article = append('article');
    const paragraphs = Array.from({ length: 12 }, (_, index) =>
      append('p', prose(`p${index}`, 40), article),
    );
    append('div', 'ad', article);
    append('p', 'byline', article);

    const result = await findTextBlocks(document, detectorOptions);
    expect(result.status).toBe('found');
    expect(result.blocks.map((block) => block.element)).toEqual([article]);
    expect(result.trace.joined).toMatchObject({ element: article, children: paragraphs.length });
  });

  it('keeps independent article siblings as separate review blocks', async () => {
    const feed = append('div');
    const first = append('article', prose('a', 130), feed);
    const second = append('article', prose('b', 120), feed);
    const result = await findTextBlocks(document, detectorOptions);
    expect(result.blocks.map((block) => block.element)).toEqual([first, second]);
  });

  it('keeps an article and substantial generic comments independently removable', async () => {
    const main = append('main');
    const article = append('article', prose('a', 180), main);
    const comments = append('div', prose('c', 140), main);
    const result = await findTextBlocks(document, detectorOptions);
    expect(result.blocks.map((block) => block.element)).toEqual([article, comments]);
  });

  it('splits around an existing selection without returning or expanding it', async () => {
    const article = append('article');
    const first = append('section', prose('a', 150), article);
    const selected = append('section', prose('s', 160), article);
    const last = append('section', prose('b', 140), article);

    const result = await findTextBlocks(document, { ...detectorOptions, selected: [selected] });
    expect(result.status).toBe('found');
    expect(result.blocks.map((block) => block.element)).toEqual([first, last]);
    expect(result.blocks.every((block) => !block.element.contains(selected))).toBe(true);
  });

  it('reports already-selected when no unselected rendered text remains', async () => {
    const article = append('article', prose('a', 200));
    append('h2', 'Short share heading');
    const result = await findTextBlocks(document, { ...detectorOptions, selected: [article] });
    expect(result).toMatchObject({ status: 'already-selected', blocks: [] });
  });

  it('does not report already-selected when a split root drops substantial direct text', async () => {
    const article = append('article');
    article.append(prose('a', 150));
    const selected = append('section', prose('s', 160), article);
    article.append(prose('b', 140));

    const result = await findTextBlocks(document, { ...detectorOptions, selected: [selected] });
    expect(result).toMatchObject({ status: 'none', blocks: [] });
    expect(result.trace.droppedDirectText).toBe(292);
  });

  it('still reports already-selected when dropped direct text is trivial', async () => {
    const article = append('article');
    article.append('Byline');
    const selected = append('section', prose('s', 160), article);

    const result = await findTextBlocks(document, { ...detectorOptions, selected: [selected] });
    expect(result).toMatchObject({ status: 'already-selected', blocks: [] });
    expect(result.trace.droppedDirectText).toBe(6);
  });

  it('rejects short and link-heavy pages', async () => {
    append('article', 'too short');
    expect((await findTextBlocks(document, detectorOptions)).status).toBe('none');
    document.body.replaceChildren();
    const grid = append('div');
    for (let index = 0; index < 3; index += 1) {
      const link = append('a', prose(String(index), 70), grid);
      link.href = `/${index}`;
    }
    expect((await findTextBlocks(document, detectorOptions)).status).toBe('none');
  });

  it('finds content below the viewport without geometry checks', async () => {
    const article = append('article', prose('a', 200));
    vi.spyOn(article, 'getBoundingClientRect').mockReturnValue({ top: 100_000, bottom: 101_000 });
    const result = await findTextBlocks(document, detectorOptions);
    expect(result.blocks[0].element).toBe(article);
    expect(article.getBoundingClientRect).not.toHaveBeenCalled();
  });

  it('returns incomplete or cancelled explicitly', async () => {
    append('article', prose('a', 200));
    expect((await findTextBlocks(document, { ...detectorOptions, maxNodes: 1 })).status).toBe(
      'incomplete',
    );
    const controller = new AbortController();
    controller.abort();
    expect(
      (await findTextBlocks(document, { ...detectorOptions, signal: controller.signal })).status,
    ).toBe('cancelled');
  });
});
