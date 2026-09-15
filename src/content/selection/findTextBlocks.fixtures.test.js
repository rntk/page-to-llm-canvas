// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findTextBlocks } from './findTextBlocks.js';

// These fixtures intentionally use the production defaults.  The unit labels
// make evaluation independent of which ancestor or sibling roots the detector
// chooses: a unit is covered when any returned root contains it.
function textUnit(parent, id, text, repeats = 1, tag = 'p') {
  const unit = document.createElement(tag);
  unit.dataset.fixtureUnit = id;
  unit.textContent = `${id}: ${text} `.repeat(repeats);
  parent.appendChild(unit);
  return unit;
}

function text(length, word = 'prose') {
  return `${word} `.repeat(Math.ceil(length / (word.length + 1)));
}

function linkUnit(parent, id, length = 900) {
  const unit = document.createElement('a');
  unit.dataset.fixtureUnit = id;
  unit.href = `/${id}`;
  unit.textContent = `${id} ${text(length, 'linked')}`;
  parent.appendChild(unit);
  return unit;
}

function evaluate(result, expected, excluded) {
  const roots = result.blocks.map(({ element }) => element);
  const selected = (unit) => roots.some((root) => root.contains(unit));
  const expectedCovered = expected.filter(selected);
  const excludedSelected = excluded.filter(selected);
  return {
    contentCoverage: expected.length ? expectedCovered.length / expected.length : 0,
    noiseLeakage: excluded.length ? excludedSelected.length / excluded.length : 0,
    expectedCovered: expectedCovered.map((unit) => unit.dataset.fixtureUnit),
    excludedSelected: excludedSelected.map((unit) => unit.dataset.fixtureUnit),
  };
}

async function expectArticleFixture(fixture) {
  const result = await findTextBlocks(document);
  const score = evaluate(result, fixture.expected, fixture.excluded);
  expect(result.status, JSON.stringify({ status: result.status, score })).toBe('found');
  expect(score.contentCoverage, JSON.stringify(score)).toBe(1);
  expect(score.noiseLeakage, JSON.stringify(score)).toBe(0);
  return result;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('findTextBlocks default-threshold fixture evaluation', () => {
  it('covers a long essay built from generic divs without selecting navigation or sidebar units', async () => {
    const nav = document.createElement('nav');
    const navigation = textUnit(nav, 'generic-nav', text(1000, 'menu'));
    document.body.appendChild(nav);
    const shell = document.createElement('div');
    const essay = document.createElement('div');
    essay.className = 'longform-copy';
    shell.appendChild(essay);
    document.body.appendChild(shell);
    const expected = [
      textUnit(essay, 'generic-essay-1', text(650)),
      textUnit(essay, 'generic-essay-2', text(650)),
      textUnit(essay, 'generic-essay-3', text(650)),
    ];
    const aside = document.createElement('aside');
    const sidebar = textUnit(aside, 'generic-sidebar', text(1000, 'related'));
    document.body.appendChild(aside);

    await expectArticleFixture({ expected, excluded: [navigation, sidebar] });
  });

  it('preserves paragraphs, lists, quotes, code, and an image within a mixed article', async () => {
    const article = document.createElement('article');
    document.body.appendChild(article);
    const expected = [
      textUnit(article, 'mixed-intro', text(500)),
      textUnit(article, 'mixed-paragraph', text(500)),
    ];
    const list = document.createElement('ul');
    article.appendChild(list);
    expected.push(textUnit(list, 'mixed-list-one', text(280), 1, 'li'));
    expected.push(textUnit(list, 'mixed-list-two', text(280), 1, 'li'));
    const quote = document.createElement('blockquote');
    article.appendChild(quote);
    expected.push(textUnit(quote, 'mixed-quote', text(450)));
    const code = document.createElement('pre');
    article.appendChild(code);
    expected.push(textUnit(code, 'mixed-code', text(450, 'const value')));
    const image = document.createElement('img');
    image.alt = 'Diagram that belongs with the article';
    article.appendChild(image);

    const result = await expectArticleFixture({ expected, excluded: [] });
    expect(result.blocks.some(({ element }) => element.contains(image))).toBe(true);
  });

  it('measures multilingual prose including text without spaces', async () => {
    const article = document.createElement('article');
    document.body.appendChild(article);
    const expected = [
      textUnit(article, 'language-japanese', '日本語の文章を読むための十分に長い本文です。', 45),
      textUnit(article, 'language-chinese', '这是一段没有空格但包含足够字符的中文文章内容。', 45),
      textUnit(article, 'language-arabic', 'هذه فقرة عربية طويلة تحتوي على نص مفيد للقارئ. ', 35),
    ];

    await expectArticleFixture({ expected, excluded: [] });
  });

  it('selects the visible article while excluding a hidden duplicate', async () => {
    const hidden = document.createElement('article');
    hidden.hidden = true;
    document.body.appendChild(hidden);
    const hiddenUnit = textUnit(hidden, 'hidden-duplicate', text(1200));
    const article = document.createElement('article');
    document.body.appendChild(article);
    const expected = [
      textUnit(article, 'visible-copy-one', text(650)),
      textUnit(article, 'visible-copy-two', text(650)),
    ];

    await expectArticleFixture({ expected, excluded: [hiddenUnit] });
  });

  it('keeps an article and long comments as separately reviewable text regions', async () => {
    const wrapper = document.createElement('main');
    document.body.appendChild(wrapper);
    const article = document.createElement('article');
    wrapper.appendChild(article);
    const comments = document.createElement('section');
    comments.className = 'comments';
    wrapper.appendChild(comments);
    const expected = [
      textUnit(article, 'story-body', text(1100)),
      textUnit(comments, 'comment-thread', text(1100, 'comment')),
    ];
    const aside = document.createElement('aside');
    const related = textUnit(aside, 'comments-related', text(1000, 'related'));
    document.body.appendChild(aside);

    const result = await expectArticleFixture({ expected, excluded: [related] });
    expect(result.blocks).toHaveLength(2);
    expect(result.blocks.map(({ element }) => element)).toEqual([article, comments]);
  });

  it('keeps two unrelated equal-strength articles as separate review blocks', async () => {
    const wrapper = document.createElement('div');
    document.body.appendChild(wrapper);
    const first = document.createElement('article');
    const second = document.createElement('article');
    wrapper.append(first, second);
    const expected = [
      textUnit(first, 'equal-first', text(1100)),
      textUnit(second, 'equal-second', text(1100)),
    ];

    const result = await expectArticleFixture({ expected, excluded: [] });
    expect(result.blocks.map(({ element }) => element)).toEqual([first, second]);
  });

  it('keeps two unrelated equal-strength generic div regions as separate review blocks', async () => {
    const wrapper = document.createElement('div');
    document.body.appendChild(wrapper);
    const first = document.createElement('div');
    first.className = 'long-read-one';
    const second = document.createElement('div');
    second.className = 'long-read-two';
    wrapper.append(first, second);
    const expected = [
      textUnit(first, 'generic-equal-first', text(1100)),
      textUnit(second, 'generic-equal-second', text(1100)),
    ];

    const result = await expectArticleFixture({ expected, excluded: [] });
    expect(result.blocks.map(({ element }) => element)).toEqual([first, second]);
  });

  it('finds the semantic article body while excluding navigation and a sidebar', async () => {
    const nav = document.createElement('nav');
    const navigation = textUnit(nav, 'semantic-nav', text(900, 'menu'));
    document.body.appendChild(nav);
    const main = document.createElement('main');
    document.body.appendChild(main);
    const article = document.createElement('article');
    main.appendChild(article);
    const expected = [
      textUnit(article, 'semantic-article-1', text(600)),
      textUnit(article, 'semantic-article-2', text(600)),
    ];
    const aside = document.createElement('aside');
    const sidebar = textUnit(aside, 'semantic-sidebar', text(900, 'related'));
    main.appendChild(aside);

    await expectArticleFixture({ expected, excluded: [navigation, sidebar] });
  });

  it('keeps clean sibling sections of an article separate from a small ad block', async () => {
    const article = document.createElement('article');
    document.body.appendChild(article);
    const expected = [
      textUnit(article, 'ad-split-first', text(700), 1, 'section'),
      textUnit(article, 'ad-split-second', text(680), 1, 'section'),
    ];
    const ad = textUnit(article, 'ad-split-ad', 'sponsored', 1, 'div');

    const result = await expectArticleFixture({ expected, excluded: [ad] });
    expect(result.blocks).toHaveLength(2);
  });

  it('adds only the remaining text when one block is already selected', async () => {
    const article = document.createElement('article');
    document.body.appendChild(article);
    const alreadySelected = textUnit(article, 'preselected-block', text(1100), 1, 'section');
    const expected = [textUnit(article, 'preselected-remaining', text(900), 1, 'section')];

    const result = await findTextBlocks(document, { selected: [alreadySelected] });
    const score = evaluate(result, expected, [alreadySelected]);
    expect(result.status, JSON.stringify({ status: result.status, score })).toBe('found');
    expect(score.contentCoverage, JSON.stringify(score)).toBe(1);
    expect(score.noiseLeakage, JSON.stringify(score)).toBe(0);
    expect(result.blocks.some(({ element }) => element === alreadySelected)).toBe(false);
  });

  it('still finds an article scrolled below the viewport', async () => {
    const article = document.createElement('article');
    document.body.appendChild(article);
    const expected = [textUnit(article, 'below-fold', text(1200))];
    vi.spyOn(article, 'getBoundingClientRect').mockReturnValue({ top: 50_000, bottom: 51_000 });

    await expectArticleFixture({ expected, excluded: [] });
    expect(article.getBoundingClientRect).not.toHaveBeenCalled();
  });

  it('collapses nested wrappers around the same article into one focused result', async () => {
    const nav = document.createElement('nav');
    const navigation = textUnit(nav, 'nested-nav', text(1000, 'menu'));
    document.body.appendChild(nav);
    const footer = document.createElement('footer');
    const footerUnit = textUnit(footer, 'nested-footer', text(1000, 'legal'));
    document.body.appendChild(footer);

    const outer = document.createElement('div');
    const middle = document.createElement('div');
    const inner = document.createElement('div');
    outer.appendChild(middle);
    middle.appendChild(inner);
    document.body.appendChild(outer);
    const article = document.createElement('article');
    inner.appendChild(article);
    const expected = [
      textUnit(article, 'nested-article-1', text(650)),
      textUnit(article, 'nested-article-2', text(650)),
    ];

    const result = await expectArticleFixture({ expected, excluded: [navigation, footerUnit] });
    expect(result.blocks).toHaveLength(1);
    const roots = result.blocks.map(({ element }) => element);
    const hasDuplicateAncestor = roots.some((root, index) =>
      roots.some(
        (other, otherIndex) =>
          index !== otherIndex && (root.contains(other) || other.contains(root)),
      ),
    );
    expect(hasDuplicateAncestor).toBe(false);
  });

  it('stays graceful on a heavily dynamic page that mutates mid-scan and exceeds the node budget', async () => {
    const article = document.createElement('article');
    document.body.appendChild(article);
    for (let index = 0; index < 30; index += 1) {
      textUnit(article, `dynamic-${index}`, text(60));
    }

    // Real infinite-scroll/ad-injection pages keep mutating while a scan is
    // in flight. Schedule a timer that appends a large new subtree and drops
    // an existing one so a yield lands mid-mutation.
    setTimeout(() => {
      for (let index = 0; index < 30; index += 1) {
        textUnit(article, `dynamic-late-${index}`, text(60));
      }
      article.firstElementChild?.remove();
    }, 0);

    const result = await findTextBlocks(document, { batchSize: 4, maxNodes: 50 });

    expect(['none', 'incomplete']).toContain(result.status);
    expect(result.blocks.every((block) => block.element.isConnected)).toBe(true);
  });

  it.each(['homepage', 'product grid', 'search results'])(
    'rejects link-heavy %s fixtures',
    async (name) => {
      const grid = document.createElement('div');
      grid.setAttribute('aria-label', name);
      document.body.appendChild(grid);
      for (let index = 0; index < 6; index += 1) linkUnit(grid, `${name}-${index}`, 280);

      const result = await findTextBlocks(document);
      const score = evaluate(result, [], Array.from(grid.querySelectorAll('[data-fixture-unit]')));
      expect(result.status, JSON.stringify({ name, status: result.status, score })).toBe('none');
      expect(score.noiseLeakage, JSON.stringify(score)).toBe(0);
    },
  );

  it('rejects empty and very short pages', async () => {
    expect((await findTextBlocks(document)).status).toBe('none');
    const short = textUnit(document.body, 'short-page', 'brief text');
    const result = await findTextBlocks(document);
    const score = evaluate(result, [], [short]);
    expect(result.status).toBe('none');
    expect(score.noiseLeakage).toBe(0);
  });
});
