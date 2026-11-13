import { describe, expect, it, vi } from 'vitest';
import {
  MAX_PAGE_HIGHLIGHT_LINES,
  buildProjectPagesOverview,
  createProjectHighlightTool,
  createProjectPageTools,
} from './projectPageTools.js';
import { formatScanResults } from './projectPageScan.js';

const pages = [
  { page: 1, title: 'Cats', url: 'https://cats.test/' },
  { page: 2, title: 'Dogs', url: 'https://dogs.test/' },
  { page: 3, title: 'Broken', url: 'https://broken.test/' },
];

const texts = {
  1: ['Cats purr when happy.', 'Cats sleep a lot.', 'Some cats dislike water.'],
  2: ['Dogs bark.', 'Dogs and cats can be friends.'],
};

function setup({ scan } = {}) {
  const loadPage = vi.fn(async (page) => {
    if (page.page === 3) throw new Error('capture failed');
    return { sentences: texts[page.page], ...(page.page === 2 ? { truncated: true } : {}) };
  });
  const tools = createProjectPageTools({ pages, loadPage, scan });
  const byName = Object.fromEntries(tools.map((tool) => [tool.definition.name, tool]));
  const run = async (name, args, maxChars = 4000, signal) =>
    JSON.parse(await byName[name].run(args, { maxChars, signal }));
  return { tools, byName, run, loadPage };
}

describe('createProjectPageTools', () => {
  it('offers read_page, search_page and ask_pages (only with a scan)', () => {
    expect(setup({ scan: vi.fn() }).tools.map((tool) => tool.definition.name)).toEqual([
      'read_page',
      'search_page',
      'ask_pages',
    ]);
    expect(setup().tools.map((tool) => tool.definition.name)).toEqual(['read_page', 'search_page']);
    for (const tool of setup({ scan: vi.fn() }).tools) {
      expect(tool.definition.parameters.type).toBe('object');
      expect(tool.definition.description.length).toBeGreaterThan(40);
    }
  });

  it('requires loadPage', () => {
    expect(() => createProjectPageTools({ pages })).toThrow(/loadPage/);
  });
});

describe('read_page', () => {
  it('returns numbered lines of one page', async () => {
    const { run, loadPage } = setup();
    expect(await run('read_page', { page: 1 })).toEqual({
      kind: 'page_text',
      page: 1,
      title: 'Cats',
      totalLines: 3,
      startLine: 1,
      endLine: 3,
      numberedText: '1: Cats purr when happy.\n2: Cats sleep a lot.\n3: Some cats dislike water.',
    });
    expect(loadPage).toHaveBeenCalledWith(pages[0]);
  });

  it('starts at start_line, clamps past the end and marks truncated captures', async () => {
    const { run } = setup();
    expect(await run('read_page', { page: 1, start_line: 3 })).toMatchObject({
      startLine: 3,
      endLine: 3,
      numberedText: '3: Some cats dislike water.',
    });
    expect(await run('read_page', { page: 2, start_line: 99 })).toMatchObject({
      startLine: 2,
      truncated: true,
    });
  });

  it('pages through a long page within the budget', async () => {
    const { run } = setup();
    const result = await run('read_page', { page: 1 }, 190);
    expect(result.endLine).toBeLessThan(3);
    expect(result.nextStartLine).toBe(result.endLine + 1);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(190);
    const next = await run('read_page', { page: 1, start_line: result.nextStartLine }, 190);
    expect(next.startLine).toBe(result.nextStartLine);
  });

  it('returns part of one line rather than nothing, and fails without any budget', async () => {
    const { byName } = setup();
    const json = await byName.read_page.run({ page: 1, start_line: 3 }, { maxChars: 175 });
    expect(json.length).toBeLessThanOrEqual(175);
    const partial = JSON.parse(json);
    expect(partial.numberedText.length).toBeLessThan(27);
    expect(partial.numberedText).toMatch(/^3: /);
    expect(partial).toMatchObject({ endLine: 3, nextStartLine: 3, lineTruncated: true });
    expect(partial.nextStartChar).toBe(partial.numberedText.length - 3);
    await expect(byName.read_page.run({ page: 1 }, { maxChars: 20 })).rejects.toThrow(/budget/);
  });

  it('continues a cut-off line through nextStartChar until the whole line is read', async () => {
    const long = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
    const loadPage = vi.fn(async () => ({ sentences: ['Intro.', long] }));
    const [readPage] = createProjectPageTools({ pages: pages.slice(0, 1), loadPage });
    let args = { page: 1, start_line: 2 };
    let collected = '';
    for (let call = 0; call < 50; call += 1) {
      const json = await readPage.run(args, { maxChars: 260 });
      expect(json.length).toBeLessThanOrEqual(260);
      const result = JSON.parse(json);
      expect(result.endLine).toBe(2);
      collected += result.numberedText.replace(/^2: …?/, '');
      if (!result.lineTruncated) {
        expect(result.nextStartLine).toBeUndefined();
        break;
      }
      expect(result.nextStartLine).toBe(2);
      args = { page: 1, start_line: 2, start_char: result.nextStartChar };
      if (call > 0) expect(result.numberedText).toMatch(/^2: …/);
    }
    expect(collected).toBe(long);
    await expect(
      readPage.run({ page: 1, start_line: 1, start_char: 6 }, { maxChars: 4000 }),
    ).rejects.toThrow(/past the end of line 1/);
  });

  it('rejects invalid page numbers with the valid range and bad start lines', async () => {
    const { byName } = setup();
    await expect(byName.read_page.run({ page: 4 }, { maxChars: 4000 })).rejects.toThrow(
      'page 4 is not a project page; valid pages are 1–3',
    );
    await expect(byName.read_page.run({}, { maxChars: 4000 })).rejects.toThrow(/valid pages/);
    await expect(byName.read_page.run({ page: '2.5' }, { maxChars: 4000 })).rejects.toThrow(
      /valid pages/,
    );
    await expect(
      byName.read_page.run({ page: 1, start_line: 0 }, { maxChars: 4000 }),
    ).rejects.toThrow(/start_line/);
  });

  it('propagates a load failure and an aborted signal', async () => {
    const { byName } = setup();
    await expect(byName.read_page.run({ page: 3 }, { maxChars: 4000 })).rejects.toThrow(
      'capture failed',
    );
    const controller = new AbortController();
    controller.abort();
    await expect(
      byName.read_page.run({ page: 1 }, { maxChars: 4000, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('lists non-contiguous page numbers in errors', async () => {
    const tools = createProjectPageTools({
      pages: [
        { page: 2, title: 'B', url: '' },
        { page: 5, title: 'E', url: '' },
      ],
      loadPage: vi.fn(),
    });
    await expect(tools[0].run({ page: 1 }, { maxChars: 1000 })).rejects.toThrow(
      'valid pages are 2, 5',
    );
  });
});

describe('search_page', () => {
  it('searches one page', async () => {
    const { run } = setup();
    expect(await run('search_page', { query: 'cats water', page: 1 })).toEqual({
      kind: 'page_search',
      query: 'cats water',
      page: 1,
      title: 'Cats',
      totalMatches: 3,
      matches: [
        { page: 1, line: 3, text: 'Some cats dislike water.' },
        { page: 1, line: 1, text: 'Cats purr when happy.' },
        { page: 1, line: 2, text: 'Cats sleep a lot.' },
      ],
      note: 'Use read_page with page and start_line to read around a hit.',
    });
  });

  it('searches all pages and lists unreadable ones instead of failing', async () => {
    const { run } = setup();
    const result = await run('search_page', { query: 'cats friends', limit: 2 });
    expect(result.scope).toBe('all pages');
    expect(result.matches).toEqual([
      { page: 2, line: 2, text: 'Dogs and cats can be friends.' },
      { page: 1, line: 1, text: 'Cats purr when happy.' },
    ]);
    expect(result.totalMatches).toBe(4);
    expect(result.matchesByPage).toEqual([
      { page: 1, matches: 3 },
      { page: 2, matches: 1 },
    ]);
    expect(result.unreadable).toEqual([{ page: 3, title: 'Broken', error: 'capture failed' }]);
  });

  it('says when nothing matched and validates its arguments', async () => {
    const { run, byName } = setup();
    expect((await run('search_page', { query: 'zebra', page: 1 })).note).toMatch(/No line matched/);
    await expect(byName.search_page.run({ query: '  ' }, { maxChars: 4000 })).rejects.toThrow(
      /query/,
    );
    await expect(
      byName.search_page.run({ query: 'cats', page: 9 }, { maxChars: 4000 }),
    ).rejects.toThrow(/valid pages are 1–3/);
    await expect(
      byName.search_page.run({ query: 'cats', limit: 0 }, { maxChars: 4000 }),
    ).rejects.toThrow(/limit/);
    await expect(
      byName.search_page.run({ query: 'cats', page: 3 }, { maxChars: 4000 }),
    ).rejects.toThrow('capture failed');
  });

  it('drops matches to fit the budget and flags the truncation', async () => {
    const { byName } = setup();
    const json = await byName.search_page.run({ query: 'cats' }, { maxChars: 420 });
    expect(json.length).toBeLessThanOrEqual(420);
    const result = JSON.parse(json);
    expect(result.truncated).toBe(true);
    expect(result.matches.length).toBeLessThan(4);
    await expect(byName.search_page.run({ query: 'cats' }, { maxChars: 50 })).rejects.toThrow(
      /budget/,
    );
  });
});

describe('ask_pages', () => {
  const scanResult = (page, relevance) => ({
    page: page.page,
    title: page.title,
    url: page.url,
    relevance,
    summary: relevance === 'high' ? 'Covers it.' : '',
    findings: relevance === 'high' ? [{ startLine: 2, endLine: 3, note: 'here' }] : [],
    totalLines: 3,
    topics: [],
  });

  it('scans the requested pages and returns the formatted results', async () => {
    const scan = vi.fn(async ({ pages: subset }) =>
      subset.map((page) => scanResult(page, page.page === 2 ? 'high' : 'none')),
    );
    const { run } = setup({ scan });
    const controller = new AbortController();
    const result = await run(
      'ask_pages',
      { question: 'Do dogs like cats?', pages: [2, 1, 2] },
      4000,
      controller.signal,
    );
    expect(scan).toHaveBeenCalledWith({
      question: 'Do dogs like cats?',
      pages: [pages[0], pages[1]],
      signal: controller.signal,
    });
    expect(result).toMatchObject({
      kind: 'page_scan',
      question: 'Do dogs like cats?',
      pagesScanned: 2,
    });
    expect(result.note).toMatch(/Quoted lines .* are the page text itself; read_page around them/);
    expect(result.results).toBe(
      formatScanResults([scanResult(pages[0], 'none'), scanResult(pages[1], 'high')], {
        maxChars: 4000,
      }),
    );
  });

  it('scans every page when pages is omitted or empty', async () => {
    const scan = vi.fn(async ({ pages: subset }) => subset.map((page) => scanResult(page, 'none')));
    const { run } = setup({ scan });
    await run('ask_pages', { question: 'q' });
    await run('ask_pages', { question: 'q', pages: [] });
    expect(scan.mock.calls.map(([call]) => call.pages.length)).toEqual([3, 3]);
  });

  it('validates its arguments before scanning', async () => {
    const scan = vi.fn();
    const { byName } = setup({ scan });
    await expect(byName.ask_pages.run({ question: '' }, { maxChars: 4000 })).rejects.toThrow(
      /question/,
    );
    await expect(
      byName.ask_pages.run({ question: 'q', pages: [7] }, { maxChars: 4000 }),
    ).rejects.toThrow(/valid pages are 1–3/);
    await expect(
      byName.ask_pages.run({ question: 'q', pages: 2 }, { maxChars: 4000 }),
    ).rejects.toThrow(/array/);
    expect(scan).not.toHaveBeenCalled();
  });

  it('fits the budget and propagates scan failures', async () => {
    const many = Array.from({ length: 30 }, (_, index) =>
      scanResult({ page: index + 1, title: `Page "${index + 1}"`, url: '' }, 'high'),
    );
    const { byName } = setup({ scan: async () => many });
    const json = await byName.ask_pages.run({ question: 'q' }, { maxChars: 600 });
    expect(json.length).toBeLessThanOrEqual(600);
    expect(JSON.parse(json).results).toMatch(/more relevant pages/);

    const failing = setup({
      scan: async () => {
        throw new Error('aborted');
      },
    });
    await expect(
      failing.byName.ask_pages.run({ question: 'q' }, { maxChars: 600 }),
    ).rejects.toThrow('aborted');
  });
});

describe('buildProjectPagesOverview', () => {
  const base = {
    pages,
    unreadablePages: [{ title: 'Private', url: 'chrome://settings', reason: 'browser page' }],
    maxChars: 6000,
  };

  it('lists pages, unreadable pages, the scan and guidance in order', () => {
    const text = buildProjectPagesOverview({
      ...base,
      scanText: 'Page 2 "Dogs" — relevance high',
      scanMode: 'llm',
    });
    const order = [
      'PROJECT PAGES',
      'Pages (3):',
      '1. Cats <https://cats.test/>',
      '3. Broken <https://broken.test/>',
      'Pages that cannot be read (1):',
      '- Private <chrome://settings>: browser page',
      'PAGE SCAN\nProduced for',
      'Page 2 "Dogs" — relevance high',
      'MERGED TOPIC TREE',
      'How to use it:',
    ].map((needle) => text.indexOf(needle));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).toMatch(/produced for the current message by a per-page pass/i);
    expect(text).toMatch(/Start from the PAGE SCAN: its quoted lines/);
    expect(text).toMatch(/language model read every line of each page/);
    expect(text).toMatch(/Not available in this chat/);
  });

  it('points to ask_pages when no scan ran and names the decision mode', () => {
    expect(buildProjectPagesOverview(base)).toMatch(
      /No page scan ran for this question\. Call ask_pages/,
    );
    expect(buildProjectPagesOverview({ ...base, scanText: 'x', scanMode: 'decision' })).toMatch(
      /decision model judged every passage/,
    );
  });

  it('includes the tree overview as an optional extra when given', () => {
    const text = buildProjectPagesOverview({
      ...base,
      treeOverview: 'PROJECT TOPIC TREE\nRoot summary: cats.',
    });
    expect(text).toContain('MERGED TOPIC TREE (optional extra)');
    expect(text).toContain('search_topics, get_topic, read_topic_content and get_claim_sources');
    expect(text).toContain('Root summary: cats.');
    expect(text).not.toMatch(/Not available in this chat/);
  });

  it('fits maxChars and gives the scan priority over a long page list', () => {
    const longPages = Array.from({ length: 300 }, (_, index) => ({
      page: index + 1,
      title: `A fairly long page title number ${index + 1}`,
      url: `https://example.test/articles/${index + 1}`,
    }));
    const scanText = Array.from({ length: 20 }, (_, i) => `Page ${i + 1} — relevance high`).join(
      '\n',
    );
    const text = buildProjectPagesOverview({
      pages: longPages,
      scanText,
      treeOverview: 'T'.repeat(5000),
      maxChars: 4000,
    });
    expect(text.length).toBeLessThanOrEqual(4000);
    expect(text).toContain(scanText);
    expect(text).toMatch(/more not listed \(use search_page or ask_pages/);
    expect(text).toContain('1. A fairly long page title number 1');
    expect(text).toContain('How to use it:');

    const tiny = buildProjectPagesOverview({ pages: longPages, scanText, maxChars: 300 });
    expect(tiny.length).toBeLessThanOrEqual(300);
  });

  it('handles a project without pages', () => {
    expect(buildProjectPagesOverview({ pages: [], maxChars: 2000 })).toContain(
      'this project has no pages',
    );
  });

  it.each(['llm', 'decision'])('preserves quoted findings in a small overview (%s)', (scanMode) => {
    const scanText = 'Page 1 "Cats" — relevance high\n> 2: Cats sleep a lot.';
    for (const treeOverview of ['', 'Tree detail. '.repeat(500)]) {
      const text = buildProjectPagesOverview({
        pages: [pages[0]],
        scanText,
        scanMode,
        treeOverview,
        maxChars: 1205,
      });
      expect(text.length).toBeLessThanOrEqual(1205);
      expect(text).toContain(scanText);
      expect(text).toContain('1. Cats <https://cats.test/>');
    }
  });

  it('keeps findings ahead of a page list that overflows a tiny budget', () => {
    const scanText = 'Page 1 — relevance high\n> 2: Cats sleep a lot.';
    const text = buildProjectPagesOverview({
      pages: Array.from({ length: 100 }, (_, i) => ({
        page: i + 1,
        title: 'Long page title '.repeat(20),
        url: 'https://example.test/',
      })),
      scanText,
      maxChars: 300,
    });
    expect(text.length).toBeLessThanOrEqual(300);
    expect(text).toContain(scanText);
  });
});

describe('createProjectHighlightTool', () => {
  const highlight = () => {
    const loadPage = vi.fn(async (page) => {
      if (page.page === 3) throw new Error('capture failed');
      return { sentences: texts[page.page] };
    });
    return { tool: createProjectHighlightTool({ pages, loadPage }), loadPage };
  };

  it('offers a page-aware highlight_span', () => {
    const { definition } = highlight().tool;
    expect(definition.name).toBe('highlight_span');
    expect(definition.parameters.required).toEqual(['page', 'start_line', 'end_line']);
    expect(definition.description).toMatch(/page scan's quoted lines/);
  });

  it('returns the range with its page and a copy of the cited lines', async () => {
    const { tool } = highlight();
    expect(await tool.resolve({ page: 1, start_line: 2, end_line: 3, label: 'Sleep' })).toEqual({
      page: 1,
      pageUrl: 'https://cats.test/',
      pageTitle: 'Cats',
      startLine: 2,
      endLine: 3,
      label: 'Sleep',
      excerpt: ['Cats sleep a lot.', 'Some cats dislike water.'],
    });
  });

  it('rejects bad pages and line ranges with outcome codes', async () => {
    const { tool } = highlight();
    await expect(tool.resolve({ page: 7, start_line: 1, end_line: 1 })).rejects.toMatchObject({
      code: 'invalid_arguments',
      message: expect.stringMatching(/valid pages are 1–3/),
    });
    await expect(tool.resolve({ page: 1, start_line: 'a', end_line: 1 })).rejects.toMatchObject({
      code: 'invalid_arguments',
    });
    await expect(tool.resolve({ page: 1, start_line: 2, end_line: 4 })).rejects.toMatchObject({
      code: 'out_of_range',
      message: expect.stringMatching(/between 1 and 3 for page 1/),
    });
    await expect(tool.resolve({ page: 3, start_line: 1, end_line: 1 })).rejects.toThrow(
      /capture failed/,
    );
  });

  it(`caps a highlight at ${MAX_PAGE_HIGHLIGHT_LINES} lines`, async () => {
    const long = Array.from({ length: 30 }, (_, i) => `Line ${i + 1}.`);
    const tool = createProjectHighlightTool({
      pages,
      loadPage: async () => ({ sentences: long }),
    });
    await expect(
      tool.resolve({ page: 1, start_line: 1, end_line: MAX_PAGE_HIGHLIGHT_LINES + 1 }),
    ).rejects.toMatchObject({ code: 'out_of_range' });
    const range = await tool.resolve({
      page: 1,
      start_line: 1,
      end_line: MAX_PAGE_HIGHLIGHT_LINES,
    });
    expect(range.excerpt).toHaveLength(MAX_PAGE_HIGHLIGHT_LINES);
  });
});
