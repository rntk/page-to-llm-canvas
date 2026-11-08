import { describe, expect, it } from 'vitest';
import { buildProjectTopicSeed, prepareIncrementalProjectTree } from './projectTopicTree.js';
import { addNode, TOPIC, ROOT } from '../pipeline/summaryTreeModel.js';
import { createProjectChatContext, createProjectChatTools, tokenize } from './projectChatTools.js';

const record = (key, title, overrides = {}) => ({
  key,
  status: 'done',
  sourceUrl: `https://${key}.test/`,
  title,
  contentRevision: `rev-${key}`,
  sentences: [
    `${key} solar panels convert sunlight into electricity.`,
    `${key} solar farms need large areas of land.`,
    `${key} wind turbines spin in strong gusts.`,
    `${key} offshore wind is expensive to maintain.`,
  ],
  topics: [
    { name: 'Solar power', sentences: [1, 2] },
    { name: 'Wind power', sentences: [3, 4] },
  ],
  topic_summary_index: {
    'Solar power': { runs: [{ text: 'Solar energy basics.', sentences: [1, 2] }] },
    'Wind power': { runs: [{ text: 'Wind energy basics.', sentences: [3, 4] }] },
  },
  ...overrides,
});

/**
 * Two articles (Alpha, Beta) that both have local sentences 1-4. Beta's wind
 * topic has no saved summary. Tree: root -> Renewables(solar A, solar B), Wind(wind A, wind B).
 */
function makeTree({ betaWindSummary = false } = {}) {
  const alpha = record('a', 'Alpha article');
  const beta = record('b', 'Beta article');
  if (!betaWindSummary) delete beta.topic_summary_index['Wind power'];
  const seed = buildProjectTopicSeed([alpha, beta]);
  const nodes = seed.nodes; // n0 A solar, n1 A wind, n2 B solar, n3 B wind
  const solar = addNode(nodes, TOPIC, 'Renewables', ['n0', 'n2']);
  nodes[solar].segments = [
    {
      text: 'Both articles describe solar power.',
      sources: [
        { kind: 'claim', child: 'n0', segment: 0 },
        { kind: 'claim', child: 'n2', segment: 0 },
      ],
    },
    { text: ' Alpha adds land use.', sources: [{ kind: 'rows', first: 2, last: 2 }] },
  ];
  const wind = addNode(nodes, TOPIC, 'Wind', ['n1', 'n3']);
  nodes[wind].segments = [
    {
      text: 'Wind turbines are covered.',
      sources: [{ kind: 'claim', child: 'n1', segment: 0 }],
    },
  ];
  const root = addNode(nodes, ROOT, 'Energy project', [solar, wind]);
  nodes[root].segments = [
    {
      text: 'The project compares solar and wind.',
      sources: [{ kind: 'claim', child: solar, segment: 0 }],
    },
  ];
  return {
    version: 1,
    status: 'done',
    rootId: root,
    nodes,
    sentences: seed.sentences,
    sources: seed.sources,
    records: seed.records,
    ids: { solar, wind, root },
  };
}

const run = async (tool, args, maxChars = 20_000) => {
  const text = await tool.run(args, { maxChars });
  expect(text.length).toBeLessThanOrEqual(maxChars);
  return JSON.parse(text);
};

const setup = (options = {}) => {
  const tree = options.tree ?? makeTree();
  const chat = createProjectChatTools({
    tree,
    eligiblePages: [],
    skippedPages: [],
    stale: false,
    ...options,
  });
  const tool = (name) => chat.tools.find((item) => item.definition.name === name);
  return { tree, chat, tool, ids: tree.ids };
};

describe('tokenize', () => {
  it('lowercases, splits on unicode words and folds diacritics', () => {
    expect(tokenize('Éolienne, WIND-power: 2024! Ünïcode 風力')).toEqual([
      'eolienne',
      'wind',
      'power',
      '2024',
      'unicode',
      '風力',
    ]);
  });
});

describe('createProjectChatTools', () => {
  it('exposes the four tools', () => {
    const { chat } = setup();
    expect(chat.tools.map((tool) => tool.definition.name)).toEqual([
      'get_topic',
      'read_topic_content',
      'search_topics',
      'get_claim_sources',
    ]);
    for (const tool of chat.tools) expect(typeof tool.run).toBe('function');
  });

  it('has no tools and says so when no tree exists', () => {
    const chat = createProjectChatTools({
      tree: null,
      eligiblePages: [{ title: 'Page', url: 'https://p.test/' }],
      skippedPages: [],
      stale: false,
    });
    expect(chat.tools).toEqual([]);
    expect(chat.preamble).toMatch(/No merged topic tree/);
    expect(chat.preamble).toContain('Page <https://p.test/>');
  });
});

describe('createProjectChatContext', () => {
  it('shares one tool set across preambles and matches createProjectChatTools', () => {
    const tree = makeTree();
    const context = createProjectChatContext(tree);
    expect(context.tools.map((tool) => tool.definition.name)).toEqual([
      'get_topic',
      'read_topic_content',
      'search_topics',
      'get_claim_sources',
    ]);
    const first = context.buildPreamble({
      skippedPages: [{ title: 'Draft one', url: 'https://d1.test/' }],
    });
    const second = context.buildPreamble({
      skippedPages: [{ title: 'Draft two', url: 'https://d2.test/' }],
    });
    expect(first).toContain('Draft one');
    expect(first).not.toContain('Draft two');
    expect(second).toContain('Draft two');
    expect(context.buildPreamble()).toBe(createProjectChatTools({ tree }).preamble);
    expect(createProjectChatContext(null).tools).toEqual([]);
  });
});

describe('preamble', () => {
  it('excludes removed articles after an incremental update while retaining historical rows', async () => {
    const prior = makeTree({ betaWindSummary: true });
    const incremental = prepareIncrementalProjectTree(prior, [record('b', 'Beta article')], {
      contentRevision: 'removed-alpha',
    });
    const tree = {
      ...incremental.tree,
      sentences: incremental.seed.sentences,
      sources: incremental.seed.sources,
      records: incremental.seed.records,
    };
    expect(tree.sources[1].recordKey).toBe('a');
    expect(tree.sentences[0]).toBe(prior.sentences[0]);

    const { chat, tool } = setup({
      tree,
      eligiblePages: [{ title: 'Alpha article', url: 'https://a.test/' }],
    });
    expect(chat.preamble).toContain('Included articles (1)');
    expect(chat.preamble).toContain('Beta article <https://b.test/>');
    expect(chat.preamble).toContain('Eligible pages not merged into this tree (1)');
    const content = await run(tool('read_topic_content'), { node_id: tree.rootId });
    expect(content.sentences_by_article.map((group) => group.article)).toEqual(['Beta article']);
    const search = await run(tool('search_topics'), { query: 'a' });
    expect(search.hits).toEqual([]);
  });

  it('treats an empty records list as explicit membership', () => {
    const { chat } = setup({ tree: { ...makeTree(), records: [] } });
    expect(chat.preamble).not.toContain('Included articles (');
    expect(chat.preamble).not.toContain('Alpha article <https://a.test/>');
    expect(chat.preamble).not.toContain('Beta article <https://b.test/>');
  });

  it('uses reachable evidence when records are absent, excluding historical and detached rows', () => {
    const tree = makeTree();
    delete tree.records;
    const extra = buildProjectTopicSeed([record('c', 'Historical article')], { base: tree });
    tree.sentences = extra.sentences;
    tree.sources = extra.sources;
    // A detached node is not evidence of membership in a tree with a saved root.
    tree.nodes.detached = { ...extra.nodes.n0, id: 'detached' };
    const { chat } = setup({ tree });
    expect(chat.preamble).toContain('Included articles (2)');
    expect(chat.preamble).toContain('Alpha article <https://a.test/>');
    expect(chat.preamble).toContain('Beta article <https://b.test/>');
    expect(chat.preamble).not.toContain('Historical article');
  });

  it('lists articles, branches with ids, root summary, skipped reasons and guidance', () => {
    const { chat, ids } = setup({
      skippedPages: [
        { title: 'Unsaved page', url: 'https://u.test/', reason: 'Save and process this page.' },
      ],
    });
    const text = chat.preamble;
    expect(text).toContain('Alpha article <https://a.test/>');
    expect(text).toContain('Beta article <https://b.test/>');
    expect(text).toContain('The project compares solar and wind.');
    expect(text).toContain(`${ids.solar} "Renewables"`);
    expect(text).toContain(`${ids.wind} "Wind"`);
    expect(text).toContain('Unsaved page <https://u.test/>: Save and process this page.');
    expect(text).toContain('Pages NOT included (1)');
    expect(text).toMatch(/start with get_topic/i);
    expect(text).toContain('search_topics');
    expect(text).toContain('read_topic_content');
    expect(text).toContain('Article title, sentences N–M');
    expect(text).not.toMatch(/out of date|changed after/);
  });

  it('adds a stale notice and lists eligible pages the snapshot lacks', () => {
    const { chat } = setup({
      stale: true,
      eligiblePages: [
        { title: 'Alpha article', url: 'https://a.test/' },
        { title: 'Gamma article', url: 'https://g.test/' },
      ],
    });
    expect(chat.preamble).toMatch(/changed after this tree was built/);
    expect(chat.preamble).toContain('Eligible pages not merged into this tree (1)');
    expect(chat.preamble).toContain('Gamma article <https://g.test/>');
  });

  it('flags an unfinished tree', () => {
    const tree = { ...makeTree(), status: 'running' };
    expect(createProjectChatTools({ tree }).preamble).toMatch(/not finished \(running\)/);
  });

  it('stays bounded for large projects and still ends with the guidance', () => {
    const skippedPages = Array.from({ length: 300 }, (_, index) => ({
      title: `Skipped ${index} ${'x'.repeat(200)}`,
      url: `https://skip.test/${index}/${'y'.repeat(200)}`,
      reason: 'z'.repeat(500),
    }));
    const { chat } = setup({ skippedPages });
    expect(chat.preamble.length).toBeLessThanOrEqual(6000);
    expect(chat.preamble).toMatch(/more not listed/);
    expect(chat.preamble).toContain('How to use it:');
    expect(chat.preamble).toContain('Skipped 0');
    const tiny = setup({ skippedPages, preambleMaxChars: 100 }).chat.preamble;
    expect(tiny.length).toBeLessThanOrEqual(1500);
  });
});

describe('get_topic', () => {
  it('opens the root by default with children, counts and article titles', async () => {
    const { tool, ids } = setup();
    const result = await run(tool('get_topic'), {});
    expect(result).toMatchObject({
      kind: 'topic',
      node_id: ids.root,
      title: 'Energy project',
      summary: 'The project compares solar and wind.',
      summary_status: 'ok',
      articles: 2,
      sentences: 8,
      childrenTotal: 2,
    });
    expect(result.children.map((child) => child.node_id)).toEqual([ids.solar, ids.wind]);
    expect(result.children[0]).toMatchObject({
      title: 'Renewables',
      kind: 'topic',
      articles: 2,
      sentences: 4,
      article_titles: ['Alpha article', 'Beta article'],
      children_count: 2,
    });
    expect(result.children[0].summary_snippet).toBeTruthy();
    expect(result.children[0].children).toBeUndefined();
  });

  it('expands one more level at depth 2 and returns passages as leaves', async () => {
    const { tool, ids } = setup();
    const result = await run(tool('get_topic'), { depth: 2 });
    const solar = result.children.find((child) => child.node_id === ids.solar);
    expect(solar.children.map((child) => child.node_id)).toEqual(['n0', 'n2']);
    expect(solar.children[0]).toMatchObject({
      kind: 'passage',
      leaf: true,
      articles: 1,
      article_titles: ['Alpha article'],
    });
    expect(solar.children[0].children).toBeUndefined();
    // Depth is capped at 2: grandchildren do not expand further.
    const deeper = await run(tool('get_topic'), { depth: 9 });
    expect(deeper.children[0].children[0].children).toBeUndefined();
  });

  it('returns a passage as a leaf with its summary and path', async () => {
    const { tool } = setup();
    const result = await run(tool('get_topic'), { node_id: 'n0', depth: 2 });
    expect(result).toMatchObject({
      node_kind: 'passage',
      leaf: true,
      summary: 'Solar energy basics.',
      path: 'Renewables > Solar power',
      children: [],
    });
  });

  it('rejects unknown ids and invalid arguments', async () => {
    const { tool } = setup();
    await expect(tool('get_topic').run({ node_id: 'n99' }, { maxChars: 5000 })).rejects.toThrow(
      /Unknown node_id "n99"/,
    );
    await expect(
      tool('get_topic').run({ node_id: 'constructor' }, { maxChars: 5000 }),
    ).rejects.toThrow(/Unknown node_id/);
    await expect(tool('get_topic').run({ node_id: 7 }, { maxChars: 5000 })).rejects.toThrow(
      /Unknown node_id/,
    );
    await expect(tool('get_topic').run({ depth: 'deep' }, { maxChars: 5000 })).rejects.toThrow(
      /depth must be an integer/,
    );
    await expect(tool('get_topic').run({ child_offset: 5 }, { maxChars: 5000 })).rejects.toThrow(
      /past the last child/,
    );
  });

  it('flags failed nodes and nodes without segments as missing', async () => {
    const tree = makeTree();
    tree.nodes.n1.failed = true;
    const { tool, ids } = setup({ tree });
    const root = await run(tool('get_topic'), { node_id: ids.wind, depth: 2 });
    const [failed, nulled] = root.children;
    expect(failed).toMatchObject({ node_id: 'n1', summary_status: 'missing' });
    expect(failed.summary_snippet).toBeUndefined();
    // Beta's wind passage never got a saved summary (segments null).
    expect(nulled).toMatchObject({ node_id: 'n3', summary_status: 'missing' });
    const leaf = await run(tool('get_topic'), { node_id: 'n3' });
    expect(leaf).toMatchObject({ summary_status: 'missing' });
    expect(leaf.note).toMatch(/read_topic_content/);
    expect(leaf.summary).toBeUndefined();
  });

  it('truncates children within the budget and continues from nextChildOffset', async () => {
    const tree = makeTree();
    const root = tree.nodes[tree.rootId];
    const kids = [];
    for (let i = 0; i < 12; i++) {
      const id = addNode(tree.nodes, TOPIC, `Extra branch ${i}`, ['n0']);
      tree.nodes[id].segments = [
        { text: `Extra summary ${i} ${'detail '.repeat(20)}`, sources: [] },
      ];
      kids.push(id);
    }
    root.children = [...root.children, ...kids];
    const { tool } = setup({ tree });
    const seen = [];
    let offset = 0;
    let pages = 0;
    for (;;) {
      const result = await run(tool('get_topic'), { child_offset: offset }, 1500);
      pages += 1;
      expect(result.children.length).toBeGreaterThan(0);
      seen.push(...result.children.map((child) => child.node_id));
      if (result.nextChildOffset === undefined) break;
      expect(result.truncated).toBe(true);
      expect(result.childrenOmitted).toBe(14 - result.nextChildOffset);
      expect(result.nextChildOffset).toBeGreaterThan(offset);
      offset = result.nextChildOffset;
    }
    expect(pages).toBeGreaterThan(1);
    expect(seen).toEqual(root.children);
  });

  it('shortens the summary and then fails clearly when the budget is tiny', async () => {
    const tree = makeTree();
    tree.nodes[tree.rootId].segments = [{ text: 'word '.repeat(1000), sources: [] }];
    const { tool } = setup({ tree });
    const result = await run(tool('get_topic'), {}, 1800);
    expect(result.summary_truncated).toBe(true);
    expect(result.summary.length).toBeLessThan(2000);
    expect(result.children.length).toBeGreaterThan(0);
    await expect(tool('get_topic').run({}, { maxChars: 50 })).rejects.toThrow(/no context budget/);
  });

  it('drops depth 2 detail when it would crowd out children', async () => {
    const { tool } = setup();
    const full = await run(tool('get_topic'), { depth: 2 });
    expect(full.depth_reduced).toBeUndefined();
    const size = JSON.stringify(full).length;
    const result = await run(tool('get_topic'), { depth: 2 }, size - 100);
    expect(result.children).toHaveLength(2);
    expect(result.depth_reduced).toBe(true);
    expect(result.children[0].children).toBeUndefined();
  });
});

describe('read_topic_content', () => {
  it('groups sentences by article with local numbers, never global row ids', async () => {
    const { tool, ids } = setup();
    const result = await run(tool('read_topic_content'), { node_id: ids.solar });
    expect(result).toMatchObject({ kind: 'topic_content', node_id: ids.solar, totalSentences: 4 });
    expect(result.nextOffset).toBeUndefined();
    expect(result.sentences_by_article).toEqual([
      {
        article: 'Alpha article',
        url: 'https://a.test/',
        sentences: [
          { line: 1, text: 'a solar panels convert sunlight into electricity.' },
          { line: 2, text: 'a solar farms need large areas of land.' },
        ],
      },
      {
        article: 'Beta article',
        url: 'https://b.test/',
        sentences: [
          { line: 1, text: 'b solar panels convert sunlight into electricity.' },
          { line: 2, text: 'b solar farms need large areas of land.' },
        ],
      },
    ]);
    // Beta's lines are 1-2, not the internal rows 5-6.
    expect(JSON.stringify(result)).not.toMatch(/"line":[56]/);
  });

  it('labels same-titled articles with their url so they stay distinct', async () => {
    const a = record('a', 'Same title');
    const b = record('b', 'Same title');
    const seed = buildProjectTopicSeed([a, b]);
    const tree = {
      nodes: seed.nodes,
      sentences: seed.sentences,
      sources: seed.sources,
      records: seed.records,
    };
    const { tool } = setup({ tree });
    const result = await run(tool('read_topic_content'), { node_id: 'n2' });
    expect(result.sentences_by_article[0].article).toBe('Same title (https://b.test/)');
  });

  it('paginates with nextOffset until every sentence is read exactly once', async () => {
    const { tool, ids } = setup();
    const lines = [];
    let offset = 0;
    for (;;) {
      const result = await run(tool('read_topic_content'), { node_id: ids.root, offset, limit: 3 });
      expect(result.returned).toBeLessThanOrEqual(3);
      for (const group of result.sentences_by_article) {
        for (const sentence of group.sentences) lines.push(`${group.article}#${sentence.line}`);
      }
      if (result.nextOffset === undefined) break;
      expect(result.nextOffset).toBe(offset + result.returned);
      offset = result.nextOffset;
    }
    expect(lines).toHaveLength(8);
    expect(new Set(lines).size).toBe(8);
    expect(lines.filter((line) => line.endsWith('#1'))).toHaveLength(2);
  });

  it('stops at the character budget and always makes progress', async () => {
    const { tool, ids } = setup();
    const first = await run(tool('read_topic_content'), { node_id: ids.root }, 520);
    expect(first.returned).toBeGreaterThan(0);
    expect(first.returned).toBeLessThan(8);
    expect(first.truncated).toBe(true);
    expect(first.nextOffset).toBe(first.returned);
    const next = await run(
      tool('read_topic_content'),
      { node_id: ids.root, offset: first.nextOffset },
      520,
    );
    expect(next.offset).toBe(first.nextOffset);
    expect(next.returned).toBeGreaterThan(0);
  });

  it('clips one oversized sentence rather than returning nothing', async () => {
    const tree = makeTree();
    tree.sentences[0] = 'long '.repeat(2000);
    const { tool } = setup({ tree });
    const result = await run(tool('read_topic_content'), { node_id: 'n0' }, 700);
    expect(result.returned).toBe(1);
    expect(result.nextOffset).toBe(1);
    const [sentence] = result.sentences_by_article[0].sentences;
    expect(sentence.textTruncated).toBe(true);
    expect(sentence.text.endsWith('…')).toBe(true);
    await expect(
      tool('read_topic_content').run({ node_id: 'n0' }, { maxChars: 60 }),
    ).rejects.toThrow(/no context budget/);
  });

  it('rejects unknown nodes, bad paging arguments and offsets past the end', async () => {
    const { tool, ids } = setup();
    const read = tool('read_topic_content');
    await expect(read.run({ node_id: 'zzz' }, { maxChars: 5000 })).rejects.toThrow(
      /Unknown node_id/,
    );
    await expect(read.run({}, { maxChars: 5000 })).rejects.toThrow(/Unknown node_id/);
    await expect(read.run({ node_id: ids.solar, offset: -1 }, { maxChars: 5000 })).rejects.toThrow(
      /offset must be an integer/,
    );
    await expect(read.run({ node_id: ids.solar, limit: 0 }, { maxChars: 5000 })).rejects.toThrow(
      /limit must be an integer/,
    );
    await expect(read.run({ node_id: ids.solar, offset: 4 }, { maxChars: 5000 })).rejects.toThrow(
      /past the last sentence/,
    );
  });
});

describe('search_topics', () => {
  it('ranks title and summary matches above sentence-only matches', async () => {
    const { tool, ids } = setup();
    const result = await run(tool('search_topics'), { query: 'wind' });
    // Nodes whose title and summary mention wind outrank everything else.
    const top = result.hits.slice(0, 3).map((hit) => hit.node_id);
    expect(top).toContain(ids.wind);
    expect(result.hits[0].path).toMatch(/^Wind/);
    const titleOnly = await run(tool('search_topics'), { query: 'renewables' });
    expect(titleOnly.hits[0]).toMatchObject({
      node_id: ids.solar,
      path: 'Renewables',
      kind: 'topic',
    });
    const solarSentenceOnly = await run(tool('search_topics'), { query: 'sunlight' });
    expect(solarSentenceOnly.hits.length).toBeGreaterThan(0);
    // Only sentences mention sunlight, so hits are passages with sentence citations.
    expect(solarSentenceOnly.hits[0].sentences.length).toBeGreaterThan(0);
    const titleRank = await run(tool('search_topics'), { query: 'renewables sunlight' });
    expect(titleRank.hits[0].node_id).toBe(ids.solar);
  });

  it('cites sentences by article and local number without global ids', async () => {
    const { tool } = setup();
    const result = await run(tool('search_topics'), { query: 'offshore maintain' });
    const hit = result.hits.find((item) => item.sentences);
    expect(hit.sentences).toEqual(
      expect.arrayContaining([{ article: expect.stringMatching(/article$/), line: 4 }]),
    );
    expect(hit.snippet).toMatch(/offshore wind/);
    expect(hit.articles).toHaveLength(1);
    expect(JSON.stringify(result)).not.toMatch(/"line":(5|6|7|8)\b/);
  });

  it('matches case-insensitively and across diacritics', async () => {
    const tree = makeTree();
    tree.sentences[1] = 'Éolienne naïve affects the Café district.';
    const { tool } = setup({ tree });
    const result = await run(tool('search_topics'), { query: 'EOLIENNE cafe' });
    expect(result.hits[0].node_id).toBe('n0');
  });

  it('caps hits per article so one article cannot crowd out the others', async () => {
    const alpha = record('a', 'Alpha article', {
      sentences: Array.from({ length: 12 }, (_, i) => `turbine ${i} and turbine blade ${i}.`),
      topics: Array.from({ length: 12 }, (_, i) => ({
        name: `Alpha topic ${i}`,
        sentences: [i + 1],
      })),
      topic_summary_index: null,
    });
    const beta = record('b', 'Beta article', {
      sentences: ['A single turbine mention.', 'Unrelated text.'],
      topics: [{ name: 'Beta topic', sentences: [1, 2] }],
      topic_summary_index: null,
    });
    const seed = buildProjectTopicSeed([alpha, beta]);
    const tree = {
      nodes: seed.nodes,
      sentences: seed.sentences,
      sources: seed.sources,
      records: seed.records,
    };
    const { tool } = setup({ tree });
    const result = await run(tool('search_topics'), { query: 'turbine', limit: 20 });
    const byArticle = new Map();
    for (const hit of result.hits) {
      for (const article of hit.articles) byArticle.set(article, (byArticle.get(article) || 0) + 1);
    }
    expect(byArticle.get('Alpha article')).toBe(3);
    expect(byArticle.get('Beta article')).toBe(1);
    expect(result.totalHits).toBe(4);
  });

  it('limits sentence citations per hit', async () => {
    const alpha = record('a', 'Alpha article', {
      sentences: Array.from({ length: 10 }, (_, i) => `gizmo number ${i} here.`),
      topics: [{ name: 'Everything', sentences: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }],
      topic_summary_index: null,
    });
    const seed = buildProjectTopicSeed([alpha]);
    const tree = {
      nodes: seed.nodes,
      sentences: seed.sentences,
      sources: seed.sources,
      records: seed.records,
    };
    const { tool } = setup({ tree });
    const result = await run(tool('search_topics'), { query: 'gizmo' });
    expect(result.hits[0].sentences).toHaveLength(3);
  });

  it('pages hits and truncates within the budget', async () => {
    const { tool } = setup();
    const all = await run(tool('search_topics'), { query: 'solar wind article', limit: 20 });
    expect(all.hits.length).toBeGreaterThan(2);
    const small = await run(tool('search_topics'), { query: 'solar wind article', limit: 20 }, 700);
    expect(small.hits.length).toBeGreaterThan(0);
    expect(small.hits.length).toBeLessThan(all.hits.length);
    expect(small.truncated).toBe(true);
    expect(small.nextOffset).toBe(small.hits.length);
    const collected = [...small.hits];
    let offset = small.nextOffset;
    while (offset !== undefined) {
      const page = await run(
        tool('search_topics'),
        { query: 'solar wind article', limit: 20, offset },
        700,
      );
      collected.push(...page.hits);
      offset = page.nextOffset;
    }
    expect(collected.map((hit) => hit.node_id)).toEqual(all.hits.map((hit) => hit.node_id));
  });

  it('reports no matches, empty queries and bad offsets', async () => {
    const { tool } = setup();
    const none = await run(tool('search_topics'), { query: 'zzzzqqq' });
    expect(none.hits).toEqual([]);
    expect(none.note).toMatch(/No topic or sentence matched/);
    await expect(
      tool('search_topics').run({ query: '  !!  ' }, { maxChars: 5000 }),
    ).rejects.toThrow(/at least one word/);
    await expect(tool('search_topics').run({}, { maxChars: 5000 })).rejects.toThrow(
      /at least one word/,
    );
    await expect(
      tool('search_topics').run({ query: 'solar', offset: 99 }, { maxChars: 5000 }),
    ).rejects.toThrow(/past the last hit/);
  });

  it('marks hits on nodes without summaries', async () => {
    const { tool } = setup();
    const result = await run(tool('search_topics'), { query: 'offshore' });
    const hit = result.hits.find((item) => item.node_id === 'n3');
    expect(hit.summary_status).toBe('missing');
  });
});

describe('get_claim_sources', () => {
  it('lists the segments of a node when segment is omitted', async () => {
    const { tool, ids } = setup();
    const result = await run(tool('get_claim_sources'), { node_id: ids.solar });
    expect(result).toMatchObject({
      kind: 'claim_segments',
      summary_status: 'ok',
      segmentsTotal: 2,
    });
    expect(result.segments).toEqual([
      { segment: 0, text: 'Both articles describe solar power.', sentences: 4 },
      { segment: 1, text: ' Alpha adds land use.'.trim(), sentences: 1 },
    ]);
  });

  it('resolves a segment through child claims to each article with local numbers', async () => {
    const { tool, ids } = setup();
    const result = await run(tool('get_claim_sources'), { node_id: ids.solar, segment: 0 });
    expect(result).toMatchObject({
      kind: 'claim_sources',
      segment: 0,
      claim: 'Both articles describe solar power.',
      totalSentences: 4,
    });
    expect(
      result.sentences_by_article.map((group) => [
        group.article,
        group.sentences.map((s) => s.line),
      ]),
    ).toEqual([
      ['Alpha article', [1, 2]],
      ['Beta article', [1, 2]],
    ]);
  });

  it('cites only the sentence of a direct rows segment', async () => {
    const { tool, ids } = setup();
    const result = await run(tool('get_claim_sources'), { node_id: ids.solar, segment: 1 });
    expect(result.sentences_by_article).toEqual([
      {
        article: 'Alpha article',
        url: 'https://a.test/',
        sentences: [{ line: 2, text: 'a solar farms need large areas of land.' }],
      },
    ]);
  });

  it('paginates and respects the budget', async () => {
    const { tool, ids } = setup();
    const first = await run(tool('get_claim_sources'), {
      node_id: ids.solar,
      segment: 0,
      limit: 3,
    });
    expect(first.returned).toBe(3);
    expect(first.nextOffset).toBe(3);
    const rest = await run(tool('get_claim_sources'), {
      node_id: ids.solar,
      segment: 0,
      offset: first.nextOffset,
    });
    expect(rest.returned).toBe(1);
    expect(rest.nextOffset).toBeUndefined();
    const tight = await run(tool('get_claim_sources'), { node_id: ids.solar, segment: 0 }, 450);
    expect(tight.returned).toBeGreaterThan(0);
    expect(tight.returned).toBeLessThan(4);
    expect(tight.truncated).toBe(true);
  });

  it('rejects bad segments, unknown nodes and nodes without summaries', async () => {
    const { tool, ids } = setup();
    const claims = tool('get_claim_sources');
    await expect(
      claims.run({ node_id: ids.solar, segment: 2 }, { maxChars: 5000 }),
    ).rejects.toThrow(/out of range; node .* has segments 0-1/);
    await expect(
      claims.run({ node_id: ids.solar, segment: -1 }, { maxChars: 5000 }),
    ).rejects.toThrow(/segment must be an integer/);
    await expect(claims.run({ node_id: 'nope', segment: 0 }, { maxChars: 5000 })).rejects.toThrow(
      /Unknown node_id/,
    );
    await expect(claims.run({ node_id: 'n3', segment: 0 }, { maxChars: 5000 })).rejects.toThrow(
      /no usable summary/,
    );
    const listing = await run(claims, { node_id: 'n3' });
    expect(listing).toMatchObject({ summary_status: 'missing', segments: [] });
    expect(listing.note).toMatch(/read_topic_content/);
  });

  it('reports a claim that cites nothing', async () => {
    const tree = makeTree();
    tree.nodes.n0.segments = [{ text: 'Uncited remark.', sources: [] }];
    const { tool } = setup({ tree });
    const result = await run(tool('get_claim_sources'), { node_id: 'n0', segment: 0 });
    expect(result.totalSentences).toBe(0);
    expect(result.note).toMatch(/cites no sentences/);
  });
});

describe('incomplete trees', () => {
  it('uses a virtual root listing loose branches when no root was saved yet', async () => {
    const tree = makeTree();
    delete tree.rootId;
    delete tree.nodes[tree.ids.root];
    tree.status = 'running';
    const { tool, ids } = setup({ tree });
    const result = await run(tool('get_topic'), {});
    expect(result).toMatchObject({ node_id: 'root', summary_status: 'missing' });
    expect(result.children.map((child) => child.node_id)).toEqual([ids.solar, ids.wind]);
    const content = await run(tool('read_topic_content'), { node_id: 'root', limit: 100 });
    expect(content.totalSentences).toBe(8);
  });

  it('skips sentences that lack a source mapping', async () => {
    const tree = makeTree();
    delete tree.sources[2];
    const { tool } = setup({ tree });
    const result = await run(tool('read_topic_content'), { node_id: 'n0' });
    expect(result.totalSentences).toBe(1);
  });
});
