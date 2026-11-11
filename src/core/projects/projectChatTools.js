// Tools and context for the project chat. The chat answers over the project's
// saved, merged topic tree only: no live pages and no raw records. Internal
// global row ids never reach the model; every sentence is identified by its
// article and that article's own sentence number, so two articles that both
// have a "sentence 1" can never be confused. Node ids ("n3") are opaque
// handles for these tools, not citations.

import { claimSentences } from '../pipeline/summaryTreeModel.js';
import { createTreeModel } from './projectTreeModel.js';
import { createTopicSearch } from './projectTopicSearch.js';

export const GET_TOPIC_TOOL = Object.freeze({
  name: 'get_topic',
  description:
    'Look at one node of the merged project topic tree: its title, short summary, article and sentence counts, and its children (id, title, kind, summary snippet, counts, article titles). Without node_id it opens the root. depth 2 also lists each child\'s children. A node with summary_status "missing" has no usable summary; use read_topic_content for it. If the result is truncated, call again with child_offset set to nextChildOffset.',
  parameters: {
    type: 'object',
    properties: {
      node_id: {
        type: 'string',
        description: 'Node id from a previous result. Omit for the root.',
      },
      depth: {
        type: 'integer',
        description: 'Levels of children to show, 1 or 2 (default 1).',
      },
      child_offset: {
        type: 'integer',
        description: 'Index of the first child to list, 0-based. Use nextChildOffset to continue.',
      },
    },
    additionalProperties: false,
  },
});

export const READ_TOPIC_CONTENT_TOOL = Object.freeze({
  name: 'read_topic_content',
  description:
    "Read the original source sentences under a topic node, grouped by article, each with its article title, url and that article's own sentence number. Use it to verify a summary or when a summary is missing. If nextOffset is returned, call again with offset set to it to keep reading.",
  parameters: {
    type: 'object',
    properties: {
      node_id: { type: 'string', description: 'Node id from get_topic or search_topics.' },
      offset: {
        type: 'integer',
        description: 'Index of the first sentence of the node to read, 0-based (default 0).',
      },
      limit: { type: 'integer', description: 'Most sentences to return in this call.' },
    },
    required: ['node_id'],
    additionalProperties: false,
  },
});

export const SEARCH_TOPICS_TOOL = Object.freeze({
  name: 'search_topics',
  description:
    'Search the merged topic tree by keywords (topic titles and summaries rank above source sentences). Returns the best matching nodes with a path, snippet, article titles and, for sentence matches, article and sentence numbers. Use node_id with get_topic or read_topic_content to look closer.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Keywords to look for.' },
      limit: { type: 'integer', description: 'Most hits to return (default 8, at most 20).' },
      offset: {
        type: 'integer',
        description: 'Number of best hits to skip. Use nextOffset to continue.',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
});

export const GET_CLAIM_SOURCES_TOOL = Object.freeze({
  name: 'get_claim_sources',
  description:
    "Show the source sentences that support one claim (segment) of a node's summary, with article title, url and that article's sentence number. Without segment it lists the node's summary segments so you can choose one (0-based).",
  parameters: {
    type: 'object',
    properties: {
      node_id: { type: 'string', description: 'Node id from get_topic or search_topics.' },
      segment: {
        type: 'integer',
        description: 'Summary segment index, 0-based. Omit to list the segments.',
      },
      offset: {
        type: 'integer',
        description: 'Index of the first supporting sentence to read. Use nextOffset to continue.',
      },
      limit: { type: 'integer', description: 'Most sentences to return in this call.' },
    },
    required: ['node_id'],
    additionalProperties: false,
  },
});

// Used when the caller does not supply a usable character budget.
const DEFAULT_MAX_CHARS = 12_000;
const PREAMBLE_MAX_CHARS = 6000;
const DEFAULT_CONTENT_LIMIT = 100;
const MAX_CONTENT_LIMIT = 500;
const DEFAULT_SEARCH_LIMIT = 8;
const MAX_SEARCH_LIMIT = 20;
const MAX_DEPTH = 2;
const SUMMARY_LIMITS = [2000, 800, 300, 100];
const SNIPPET_CHARS = 160;
const SENTENCE_SNIPPET_CHARS = 200;
const TITLE_CHARS = 120;
const ARTICLE_TITLES_SHOWN = 4;

const noBudget = () => new Error('no context budget is left to return this result');

const clip = (text, max) => {
  const flat = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
};

const asArgs = (args) => (args && typeof args === 'object' ? args : {});

const resolveBudget = (maxChars) => {
  const value = Math.floor(Number(maxChars));
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_CHARS;
};

function intArg(value, name, { min = 0, max = Infinity, fallback }) {
  if (value === undefined || value === null) return fallback;
  const number = Number(value);
  if (typeof value === 'boolean' || !Number.isInteger(number) || number < min) {
    throw new Error(`${name} must be an integer of at least ${min}`);
  }
  return Math.min(number, max);
}

/**
 * Largest count in [0, total] whose built result fits the budget, or -1 when
 * even the empty result does not fit. Results grow with the count.
 * @param {number} total
 * @param {function(number): object} build
 * @param {number} maxChars
 * @returns {number}
 */
function fitCount(total, build, maxChars) {
  const fits = (count) => JSON.stringify(build(count)).length <= maxChars;
  if (!fits(0)) return -1;
  let low = 0;
  let high = total;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(mid)) low = mid;
    else high = mid - 1;
  }
  return low;
}

/**
 * Serialize a one-item result whose text is shrunk until the JSON fits the budget.
 * Binary search on the text limit: JSON escaping makes characters cost a variable
 * number of bytes, so the overshoot cannot be subtracted from the limit directly.
 * Throws when not even one character of text fits.
 * @param {number} textLength Full length of the text being shrunk.
 * @param {function(number): object} build Result with the text limited to the given length.
 * @param {number} maxChars
 * @returns {string}
 */
function fitText(textLength, build, maxChars) {
  const render = (limit) => JSON.stringify(build(limit));
  let best = render(Math.max(1, textLength));
  if (best.length <= maxChars) return best;
  let low = 1;
  let high = textLength - 1;
  best = render(low);
  if (best.length > maxChars) throw noBudget();
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const json = render(mid);
    if (json.length <= maxChars) {
      low = mid;
      best = json;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

/**
 * Sentences as article-grouped citations; sentences of one article stay together
 * because their ids are sorted and each article's ids are contiguous.
 * @param {object} model
 * @param {number[]} ids
 * @param {number} [textLimit] Clip the first sentence's text to this many characters.
 */
function groupSentences(model, ids, textLimit) {
  const groups = [];
  ids.forEach((id, index) => {
    const { article, line, text } = model.cite(id);
    let group = groups.at(-1);
    if (!group || group.key !== article.key) {
      group = { key: article.key, article: article.label, url: article.url, sentences: [] };
      groups.push(group);
    }
    const clipped = index === 0 && textLimit !== undefined && text.length > textLimit;
    group.sentences.push({
      line,
      text: clipped ? `${text.slice(0, Math.max(0, textLimit - 1))}…` : text,
      ...(clipped ? { textTruncated: true } : {}),
    });
  });
  return groups.map(({ key: _key, ...group }) => group);
}

/**
 * Paginated, budget-bounded sentences for one node or claim.
 * @param {object} model
 * @param {number[]} allIds Ordered sentence ids of the node or claim.
 * @param {object} options
 * @param {object} options.head Fields placed before the sentences.
 * @param {number} options.offset
 * @param {number} options.limit
 * @param {number} options.maxChars
 * @returns {string}
 */
function packSentences(model, allIds, { head, offset, limit, maxChars }) {
  const ids = allIds.slice(offset);
  const wanted = Math.min(limit, ids.length);
  const build = (count, textLimit) => {
    const nextOffset = offset + count;
    const more = nextOffset < allIds.length;
    return {
      ...head,
      totalSentences: allIds.length,
      offset,
      returned: count,
      ...(more ? { nextOffset } : {}),
      ...(more && count < wanted ? { truncated: true } : {}),
      sentences_by_article: groupSentences(model, ids.slice(0, count), textLimit),
    };
  };
  const count = fitCount(wanted, (n) => build(n), maxChars);
  if (count < 0) throw noBudget();
  if (count === 0 && wanted > 0) {
    // Always make progress: return the start of one sentence rather than none.
    return fitText(model.cite(ids[0]).text.length, (textLimit) => build(1, textLimit), maxChars);
  }
  return JSON.stringify(build(count));
}

function describeChild(model, node, depth) {
  const articles = model.articlesOf(node);
  const missing = !model.hasSummary(node);
  const kids = model.childrenOf(node);
  return {
    node_id: node.id,
    title: clip(node.title, TITLE_CHARS),
    kind: node.kind,
    summary_status: missing ? 'missing' : 'ok',
    ...(missing ? {} : { summary_snippet: clip(model.summaryOf(node), SNIPPET_CHARS) }),
    articles: articles.length,
    sentences: model.sentenceIds(node).length,
    article_titles: articles.slice(0, ARTICLE_TITLES_SHOWN).map((a) => clip(a.label, TITLE_CHARS)),
    ...(articles.length > ARTICLE_TITLES_SHOWN
      ? { more_articles: articles.length - ARTICLE_TITLES_SHOWN }
      : {}),
    ...(kids.length === 0 ? { leaf: true } : { children_count: kids.length }),
    ...(depth > 1 && kids.length
      ? { children: kids.map((kid) => describeChild(model, kid, 1)) }
      : {}),
  };
}

function createGetTopic(model) {
  return {
    definition: GET_TOPIC_TOOL,
    async run(rawArgs, { maxChars } = {}) {
      const args = asArgs(rawArgs);
      const budget = resolveBudget(maxChars);
      const node =
        args.node_id === undefined || args.node_id === null
          ? model.root
          : model.getNode(args.node_id);
      const depth = intArg(args.depth, 'depth', { min: 1, max: MAX_DEPTH, fallback: 1 });
      const childOffset = intArg(args.child_offset, 'child_offset', { fallback: 0 });
      const kids = model.childrenOf(node);
      if (childOffset > 0 && childOffset >= kids.length) {
        throw new Error(`child_offset ${childOffset} is past the last child (${kids.length})`);
      }
      const articles = model.articlesOf(node);
      const missing = !model.hasSummary(node);
      const summary = model.summaryOf(node);
      const path = model.pathTitles(node);

      const attempt = (summaryLimit, childDepth, reduced) => {
        const items = kids.slice(childOffset).map((kid) => describeChild(model, kid, childDepth));
        const clipped = summary.length > summaryLimit;
        const head = {
          kind: 'topic',
          node_id: node.id,
          title: clip(node.title, TITLE_CHARS),
          node_kind: node.kind,
          ...(path.length ? { path: path.join(' > ') } : {}),
          summary_status: missing ? 'missing' : 'ok',
          ...(missing
            ? {
                note: 'No usable summary for this node; use read_topic_content to read its sentences.',
              }
            : { summary: clipped ? clip(summary, summaryLimit) : summary }),
          ...(clipped ? { summary_truncated: true } : {}),
          articles: articles.length,
          article_titles: articles.slice(0, 10).map((a) => clip(a.label, TITLE_CHARS)),
          ...(articles.length > 10 ? { more_articles: articles.length - 10 } : {}),
          sentences: model.sentenceIds(node).length,
          ...(kids.length === 0 ? { leaf: true } : {}),
          childrenTotal: kids.length,
          ...(childOffset ? { childOffset } : {}),
          ...(reduced ? { depth_reduced: true } : {}),
        };
        const build = (count) => {
          const next = childOffset + count;
          return {
            ...head,
            children: items.slice(0, count),
            ...(next < kids.length
              ? { truncated: true, nextChildOffset: next, childrenOmitted: kids.length - next }
              : {}),
          };
        };
        return { build, total: items.length, count: fitCount(items.length, build, budget) };
      };

      const need = Math.min(1, kids.length - childOffset);
      for (const limit of SUMMARY_LIMITS) {
        let best = attempt(limit, depth, false);
        if (depth > 1 && best.count < best.total) {
          const shallow = attempt(limit, 1, true);
          if (shallow.count > best.count) best = shallow;
        }
        if (best.count >= need) return JSON.stringify(best.build(best.count));
      }
      throw noBudget();
    },
  };
}

function createReadTopicContent(model) {
  return {
    definition: READ_TOPIC_CONTENT_TOOL,
    async run(rawArgs, { maxChars } = {}) {
      const args = asArgs(rawArgs);
      const node = model.getNode(args.node_id);
      const ids = model.sentenceIds(node);
      const offset = intArg(args.offset, 'offset', { fallback: 0 });
      const limit = intArg(args.limit, 'limit', {
        min: 1,
        max: MAX_CONTENT_LIMIT,
        fallback: DEFAULT_CONTENT_LIMIT,
      });
      if (ids.length && offset >= ids.length) {
        throw new Error(`offset ${offset} is past the last sentence (${ids.length})`);
      }
      return packSentences(model, ids, {
        head: { kind: 'topic_content', node_id: node.id, title: clip(node.title, TITLE_CHARS) },
        offset,
        limit,
        maxChars: resolveBudget(maxChars),
      });
    },
  };
}

function createGetClaimSources(model) {
  return {
    definition: GET_CLAIM_SOURCES_TOOL,
    async run(rawArgs, { maxChars } = {}) {
      const args = asArgs(rawArgs);
      const budget = resolveBudget(maxChars);
      const node = model.getNode(args.node_id);
      const segments = model.hasSummary(node) ? node.segments : [];
      const head = { node_id: node.id, title: clip(node.title, TITLE_CHARS) };

      if (args.segment === undefined || args.segment === null) {
        const items = segments.map((segment, index) => ({
          segment: index,
          text: clip(segment.text, 300),
          sentences: model.usable(claimSentences(node, index, model.tree.nodes)).length,
        }));
        const build = (count) => ({
          kind: 'claim_segments',
          ...head,
          summary_status: segments.length ? 'ok' : 'missing',
          ...(segments.length
            ? {}
            : { note: 'No usable summary for this node; use read_topic_content instead.' }),
          segmentsTotal: items.length,
          segments: items.slice(0, count),
          ...(count < items.length
            ? { truncated: true, segmentsOmitted: items.length - count }
            : {}),
        });
        const count = fitCount(items.length, build, budget);
        if (count < 0) throw noBudget();
        return JSON.stringify(build(count));
      }

      const segment = intArg(args.segment, 'segment', { fallback: 0 });
      if (!segments.length) {
        throw new Error(
          `Node ${node.id} has no usable summary segments; use read_topic_content instead.`,
        );
      }
      if (segment >= segments.length) {
        throw new Error(
          `segment ${segment} is out of range; node ${node.id} has segments 0-${segments.length - 1}`,
        );
      }
      const ids = model.usable(claimSentences(node, segment, model.tree.nodes));
      const offset = intArg(args.offset, 'offset', { fallback: 0 });
      const limit = intArg(args.limit, 'limit', {
        min: 1,
        max: MAX_CONTENT_LIMIT,
        fallback: DEFAULT_CONTENT_LIMIT,
      });
      if (ids.length && offset >= ids.length) {
        throw new Error(`offset ${offset} is past the last sentence (${ids.length})`);
      }
      return packSentences(model, ids, {
        head: {
          kind: 'claim_sources',
          ...head,
          segment,
          claim: clip(segments[segment].text, 600),
          ...(ids.length
            ? {}
            : { note: 'This claim cites no sentences; use read_topic_content to check it.' }),
        },
        offset,
        limit,
        maxChars: budget,
      });
    },
  };
}

function createSearchTopics(model) {
  const search = createTopicSearch(model);
  return {
    definition: SEARCH_TOPICS_TOOL,
    async run(rawArgs, { maxChars } = {}) {
      const args = asArgs(rawArgs);
      const budget = resolveBudget(maxChars);
      const query = String(args.query ?? '').trim();
      const ranked = search(query);
      const limit = intArg(args.limit, 'limit', {
        min: 1,
        max: MAX_SEARCH_LIMIT,
        fallback: DEFAULT_SEARCH_LIMIT,
      });
      const offset = intArg(args.offset, 'offset', { fallback: 0 });
      const toHit = ({ node, score, hits, inSummary, articles }) => {
        const lines = hits
          .map((hit) => model.cite(hit.id))
          .sort((a, b) => a.id - b.id)
          .map((cited) => ({ article: cited.article.label, line: cited.line }));
        const summary = model.summaryOf(node);
        const snippet = inSummary
          ? clip(summary, SNIPPET_CHARS)
          : hits.length
            ? clip(model.cite(hits[0].id).text, SENTENCE_SNIPPET_CHARS)
            : clip(summary || node.title, SNIPPET_CHARS);
        return {
          node_id: node.id,
          path: model.pathTitles(node).join(' > '),
          kind: node.kind,
          ...(summary ? {} : { summary_status: 'missing' }),
          snippet,
          articles: articles.slice(0, ARTICLE_TITLES_SHOWN).map((a) => clip(a.label, TITLE_CHARS)),
          ...(articles.length > ARTICLE_TITLES_SHOWN
            ? { more_articles: articles.length - ARTICLE_TITLES_SHOWN }
            : {}),
          ...(lines.length ? { sentences: lines } : {}),
          score: Math.round(score * 100) / 100,
        };
      };

      if (offset > 0 && offset >= ranked.length) {
        throw new Error(`offset ${offset} is past the last hit (${ranked.length})`);
      }
      const page = ranked.slice(offset, offset + limit).map(toHit);
      const build = (count) => {
        const next = offset + count;
        return {
          kind: 'search_results',
          query,
          totalHits: ranked.length,
          offset,
          hits: page.slice(0, count),
          ...(next < ranked.length ? { nextOffset: next } : {}),
          ...(count < page.length ? { truncated: true } : {}),
          ...(ranked.length ? {} : { note: 'No topic or sentence matched; try other keywords.' }),
        };
      };
      const count = fitCount(page.length, build, budget);
      if (count < 0) throw noBudget();
      if (count === 0 && page.length) {
        // Always make progress: shrink the first hit's snippet instead of returning none.
        const [first] = page;
        return fitText(
          first.snippet.length,
          (snippetLimit) => ({
            ...build(0),
            hits: [{ ...first, snippet: clip(first.snippet, snippetLimit) }],
            nextOffset: offset + 1 < ranked.length ? offset + 1 : undefined,
            truncated: true,
          }),
          budget,
        );
      }
      return JSON.stringify(build(count));
    },
  };
}

const USAGE_GUIDANCE = [
  'You can only see this merged topic tree through the tools; you cannot read live pages or unsaved text.',
  'Start with get_topic (the root, then a branch), and use search_topics to find where a subject is discussed.',
  'Summaries are short pointers. Before stating specifics, verify them with read_topic_content (or get_claim_sources for one summary claim).',
  'A node with summary_status "missing" has no summary: read its content instead.',
  'Cite as "Article title, sentences N–M" using the article titles and sentence numbers in tool results. Never cite node ids; they are only handles for the tools.',
  'If a question concerns a page that is not included, say that it is not included instead of guessing.',
];

function listSection(heading, items, format, budget) {
  if (!items.length) return '';
  const lines = [heading];
  let used = heading.length + 1;
  let shown = 0;
  for (const item of items) {
    const line = format(item);
    if (shown >= 1 && used + line.length + 1 > budget) break;
    lines.push(line);
    used += line.length + 1;
    shown += 1;
  }
  if (shown < items.length) lines.push(`- ...and ${items.length - shown} more not listed`);
  return lines.join('\n');
}

function buildPreamble(model, { tree, eligiblePages, skippedPages, stale, maxChars }) {
  const pages = (list) =>
    Array.isArray(list) ? list.filter((page) => page && typeof page === 'object') : [];
  const skipped = pages(skippedPages);
  const eligible = pages(eligiblePages);
  const label = (page) => clip(page.title || page.url || 'Untitled page', 100);
  const where = (page) => (page.url ? ` <${clip(page.url, 110)}>` : '');

  const notes = ['PROJECT TOPIC TREE'];
  if (!model) {
    notes.push(
      'No merged topic tree has been built for this project yet, so there is nothing to search or read. Tell the user to run "Merge similar topics" from Project actions first.',
    );
  } else {
    const status = tree.status ?? 'done';
    notes.push(
      status === 'done'
        ? 'Status: a saved merged tree of topics from the included articles.'
        : `Status: the merged tree is not finished (${status}${
            tree.error ? `: ${clip(tree.error, 160)}` : ''
          }); some branches or summaries may be missing.`,
    );
  }
  if (stale) {
    notes.push(
      'Notice: the project pages or their saved topics changed after this tree was built, so it may not match the current pages. Suggest rebuilding it.',
    );
  }

  const included = model ? model.articles : [];
  const includedUrls = new Set(included.map((article) => article.url));
  const notMerged = model ? eligible.filter((page) => !includedUrls.has(page.url)) : eligible;

  const fixed = [];
  if (model) {
    const rootSummary = model.summaryOf(model.root);
    fixed.push(
      rootSummary
        ? `Root summary: ${clip(rootSummary, 700)}`
        : 'Root summary: missing; start from the top-level branches.',
    );
  }
  const guidance = ['How to use it:', ...USAGE_GUIDANCE.map((line) => `- ${line}`)].join('\n');
  const fixedLength = [...notes, ...fixed, guidance].join('\n\n').length;
  let remaining = Math.max(0, maxChars - fixedLength - 200);

  const sections = [];
  const take = (share) => Math.floor(remaining * share);
  const addSection = (text) => {
    if (!text) return;
    sections.push(text);
    remaining = Math.max(0, remaining - text.length - 2);
  };

  if (model) {
    const branches = model.childrenOf(model.root);
    addSection(
      listSection(
        `Top-level branches (${branches.length}; open with get_topic node_id):`,
        branches,
        (node) =>
          `- ${node.id} "${clip(node.title, 80)}" (${model.articlesOf(node).length} articles, ${
            model.sentenceIds(node).length
          } sentences${model.hasSummary(node) ? '' : ', summary missing'})`,
        take(0.4),
      ),
    );
    addSection(
      listSection(
        `Included articles (${included.length}):`,
        included,
        (article) => `- ${clip(article.title, 100)}${where(article)}`,
        take(0.5),
      ),
    );
  }
  addSection(
    listSection(
      model
        ? `Eligible pages not merged into this tree (${notMerged.length}):`
        : `Pages ready to merge (${notMerged.length}):`,
      notMerged,
      (page) => `- ${label(page)}${where(page)}`,
      take(0.5),
    ),
  );
  addSection(
    listSection(
      `Pages NOT included (${skipped.length}):`,
      skipped,
      (page) => `- ${label(page)}${where(page)}: ${clip(page.reason || 'not available', 120)}`,
      take(1),
    ),
  );

  const text = [...notes, ...fixed, ...sections, guidance].join('\n\n');
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}

/**
 * Tools and context for a chat over a project's merged topic tree.
 * @param {object} input
 * @param {object|null} input.tree Saved project snapshot (`project.topic_tree`): nodes,
 *   sentences, sources, records and rootId.
 * @param {Array<{title: string, url: string}>} [input.eligiblePages] Pages that can be merged.
 * @param {Array<{title: string, url: string, reason: string}>} [input.skippedPages] Pages left out.
 * @param {boolean} [input.stale] Whether pages or topics changed since the tree was built.
 * @param {number} [input.preambleMaxChars] Upper bound for the preamble text.
 * @returns {{preamble: string, tools: Array<{definition: object,
 *   run: function(object, {maxChars: number}): Promise<string>}>}}
 */
export function createProjectChatTools({ tree, ...preambleInput } = {}) {
  const { tools, buildPreamble: preamble } = createProjectChatContext(tree);
  return { preamble: preamble(preambleInput), tools };
}

/**
 * Tools over a project's merged topic tree plus a cheap preamble builder that
 * reuses the same parsed tree. Build this once per tree; call `buildPreamble`
 * whenever the page lists or staleness change.
 * @param {object|null} tree Saved project snapshot (`project.topic_tree`).
 * @returns {{tools: Array<{definition: object, run: function(object, {maxChars: number}): Promise<string>}>,
 *   buildPreamble: function({eligiblePages?: object[], skippedPages?: object[], stale?: boolean, preambleMaxChars?: number}=): string}}
 */
export function createProjectChatContext(tree) {
  const model = createTreeModel(tree);
  return {
    tools: model
      ? [
          createGetTopic(model),
          createReadTopicContent(model),
          createSearchTopics(model),
          createGetClaimSources(model),
        ]
      : [],
    buildPreamble({
      eligiblePages = [],
      skippedPages = [],
      stale = false,
      preambleMaxChars = PREAMBLE_MAX_CHARS,
    } = {}) {
      const maxChars = Number.isFinite(preambleMaxChars)
        ? Math.max(1500, preambleMaxChars)
        : PREAMBLE_MAX_CHARS;
      return buildPreamble(model, { tree, eligiblePages, skippedPages, stale, maxChars });
    },
  };
}
