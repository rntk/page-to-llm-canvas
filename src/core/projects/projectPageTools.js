// Page tools and overview for the project chat. The chat model does not get
// whole pages up front: the overview lists the pages and the per-page scan for
// the current question, which quotes the relevant page lines verbatim, and
// these tools let it read or search specific pages, or re-run the scan for a
// different sub-question.

import { rankPageLines } from '../../chat/readPageTool.js';
import { CHAT_TOOL_OUTCOMES } from '../../shared/runtime/telemetry.js';
import { makeAbortError } from '../llm/abortSignals.js';
import { parallelMap } from '../llm/concurrency.js';
import { PAGE_SCAN_MODES, formatScanResults } from './projectPageScan.js';

/** @typedef {import('./projectPageScan.js').ScanPage} ScanPage */
/** @typedef {import('./projectPageScan.js').LoadedPage} LoadedPage */
/** @typedef {import('./projectPageScan.js').PageScanResult} PageScanResult */

const PAGE_NUMBER_DESCRIPTION = 'Number of the project page, as listed in the overview.';

export const PROJECT_READ_PAGE_TOOL = Object.freeze({
  name: 'read_page',
  description:
    'Read one project page as numbered lines, a bounded window at a time. Start near the lines a scan finding or search hit points to rather than at the top. If nextStartLine is returned, call again with start_line set to it (and start_char set to nextStartChar when present) to keep reading. lineTruncated means the last line was cut off mid-line.',
  parameters: {
    type: 'object',
    properties: {
      page: { type: 'integer', description: PAGE_NUMBER_DESCRIPTION },
      start_line: {
        type: 'integer',
        description: 'First page line to read, 1-based (default 1).',
      },
      start_char: {
        type: 'integer',
        description:
          'Character offset within start_line to resume a cut-off line, 0-based (default 0). Use the nextStartChar value returned earlier.',
      },
    },
    required: ['page'],
    additionalProperties: false,
  },
});

export const PROJECT_SEARCH_PAGE_TOOL = Object.freeze({
  name: 'search_page',
  description:
    'Search project pages for keywords. With page it searches that page; without page it searches every page. Returns the best matching lines (page number, line number, text), best first. Use read_page with start_line to read around a hit.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Keywords to look for.' },
      page: {
        type: 'integer',
        description: `${PAGE_NUMBER_DESCRIPTION} Omit to search all pages.`,
      },
      limit: { type: 'integer', description: 'Most lines to return (default 8, at most 20).' },
    },
    required: ['query'],
    additionalProperties: false,
  },
});

export const ASK_PAGES_TOOL = Object.freeze({
  name: 'ask_pages',
  description:
    'Scan pages for a question: every line of each page is checked, and each page reports how relevant it is and quotes the lines that matter. The overview already has a scan for the current message; use this only for a different sub-question. Read around the quoted lines with read_page when you need context.',
  parameters: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: 'The specific question to check each page against.',
      },
      pages: {
        type: 'array',
        items: { type: 'integer' },
        description: 'Page numbers to scan. Omit to scan all pages.',
      },
    },
    required: ['question'],
    additionalProperties: false,
  },
});

// Longest passage one highlight may cover, and the most excerpt text stored
// with it (the event keeps the lines so it still shows after the page changes).
export const MAX_PAGE_HIGHLIGHT_LINES = 12;
const MAX_EXCERPT_CHARS = 1500;

export const PROJECT_HIGHLIGHT_TOOL = Object.freeze({
  name: 'highlight_span',
  description: `Mark consecutive lines of one project page as evidence. The user sees each highlight as an excerpt of the page, quoted from its text. Use page line numbers from read_page or search_page results or the page scan's quoted lines, for lines you have read. At most ${MAX_PAGE_HIGHLIGHT_LINES} lines per call; use separate calls for separate passages.`,
  parameters: {
    type: 'object',
    properties: {
      page: { type: 'integer', description: PAGE_NUMBER_DESCRIPTION },
      start_line: { type: 'integer', description: 'First page line, 1-based and inclusive.' },
      end_line: { type: 'integer', description: 'Last page line, 1-based and inclusive.' },
      label: {
        type: 'string',
        description:
          'Optional very short tag (max ~6 words) naming why this passage matters. A tag, not a sentence.',
      },
    },
    required: ['page', 'start_line', 'end_line'],
    additionalProperties: false,
  },
});

// Used when the caller does not supply a usable character budget.
const DEFAULT_MAX_CHARS = 12_000;
const DEFAULT_SEARCH_LIMIT = 8;
const MAX_SEARCH_LIMIT = 20;
// Longest stretch of one matching line returned, so a few long lines cannot
// use up the whole result budget.
const MAX_HIT_CHARS = 400;
const TITLE_CHARS = 120;
const URL_CHARS = 110;
const ERROR_CHARS = 160;
const QUESTION_CHARS = 500;
// Pages loaded at once by an all-pages search.
const SEARCH_LOAD_CONCURRENCY = 4;
const SEARCH_NOTE = 'Use read_page with page and start_line to read around a hit.';
const SCAN_NOTE =
  'Quoted lines (">") are the page text itself; read_page around them for context, and for findings whose lines are not quoted.';

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

const noBudget = () => new Error('no context budget is left to return this result');

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : makeAbortError('The chat turn was cancelled.');
}

const sentencesOf = (loaded) =>
  Array.isArray(loaded?.sentences) ? loaded.sentences.map((s) => String(s ?? '')) : [];

const titleOf = (page) => clip(page?.title || page?.url || 'Untitled page', TITLE_CHARS);

function intArg(value, name, { min = 1, max = Infinity, fallback }) {
  if (value === undefined || value === null) return fallback;
  const number = Number(value);
  if (typeof value === 'boolean' || !Number.isInteger(number) || number < min) {
    throw new Error(`${name} must be an integer of at least ${min}`);
  }
  return Math.min(number, max);
}

/**
 * Describes valid page numbers for error messages: "1–5", or a list when not contiguous.
 * @param {number[]} numbers
 */
function validRange(numbers) {
  if (!numbers.length) return 'this project has no pages';
  const sorted = [...numbers].sort((a, b) => a - b);
  const contiguous = sorted.every((n, i) => i === 0 || n === sorted[i - 1] + 1);
  return contiguous
    ? `valid pages are ${sorted[0]}–${sorted.at(-1)}`
    : `valid pages are ${sorted.join(', ')}`;
}

/**
 * Page tools for the project chat.
 * @param {object} input
 * @param {ScanPage[]} input.pages Project pages, numbered as in the overview.
 * @param {function(ScanPage): Promise<LoadedPage>} input.loadPage Reads one page;
 *   callers cache it so repeated reads cost one capture.
 * @param {function({question: string, pages: ScanPage[], signal?: AbortSignal}):
 *   Promise<PageScanResult[]>} [input.scan] Per-page scan; without it ask_pages is not offered.
 * @returns {Array<{definition: object,
 *   run: function(object, {maxChars: number, signal?: AbortSignal}): Promise<string>}>}
 */
export function createProjectPageTools({ pages, loadPage, scan }) {
  const list = (Array.isArray(pages) ? pages : []).filter(
    (page) => page && Number.isInteger(page.page),
  );
  if (typeof loadPage !== 'function') throw new Error('loadPage is required');
  const byNumber = new Map(list.map((page) => [page.page, page]));
  const numbers = [...byNumber.keys()];

  const pageArg = (value) => {
    const number = Number(value);
    if (
      value === undefined ||
      value === null ||
      typeof value === 'boolean' ||
      !byNumber.has(number)
    ) {
      throw new Error(`page ${String(value)} is not a project page; ${validRange(numbers)}`);
    }
    return byNumber.get(number);
  };

  const loadSentences = async (page, signal) => {
    const loaded = await loadPage(page);
    throwIfAborted(signal);
    const sentences = sentencesOf(loaded);
    if (!sentences.length) throw new Error(`page ${page.page} has no readable text`);
    return { loaded, sentences };
  };

  const readPage = {
    definition: PROJECT_READ_PAGE_TOOL,
    async run(rawArgs, { maxChars, signal } = {}) {
      const args = asArgs(rawArgs);
      const page = pageArg(args.page);
      const requested = intArg(args.start_line, 'start_line', { fallback: 1 });
      const startChar = intArg(args.start_char, 'start_char', { min: 0, fallback: 0 });
      throwIfAborted(signal);
      const { loaded, sentences } = await loadSentences(page, signal);
      const totalLines = sentences.length;
      const startLine = Math.min(requested, totalLines);
      const lineText = (line) => sentences[line - 1].trim();
      if (startChar > 0 && startChar >= lineText(startLine).length) {
        throw new Error(
          `start_char ${startChar} is past the end of line ${startLine} (${lineText(startLine).length} characters)`,
        );
      }
      // `nextStartChar` set means line `endLine` was cut off at that offset.
      const build = (endLine, numberedText, nextStartChar = null) => ({
        kind: 'page_text',
        page: page.page,
        title: titleOf(page),
        totalLines,
        startLine,
        ...(startChar > 0 ? { startChar } : {}),
        endLine,
        ...(nextStartChar !== null
          ? { nextStartLine: endLine, nextStartChar, lineTruncated: true }
          : endLine < totalLines
            ? { nextStartLine: endLine + 1 }
            : {}),
        ...(loaded?.truncated ? { truncated: true } : {}),
        numberedText,
      });
      // Envelope with the widest numbers it can hold; text is measured JSON-escaped.
      const longestLine = Math.max(...sentences.map((s) => s.trim().length));
      const envelope = Math.max(
        JSON.stringify(build(totalLines - 1, '')).length,
        JSON.stringify(build(totalLines, '', longestLine)).length,
      );
      const textBudget = resolveBudget(maxChars) - envelope;
      const escaped = (text) => JSON.stringify(text).length - 2;
      const lines = [];
      let used = 0;
      let endLine = startLine - 1;
      let nextStartChar = null;
      for (let line = startLine; line <= totalLines; line += 1) {
        const offset = line === startLine ? startChar : 0;
        // A resumed line is marked with "…" so it reads as a continuation.
        const prefix = `${line}: ${offset > 0 ? '…' : ''}`;
        const body = lineText(line).slice(offset);
        const text = `${prefix}${body}`;
        const cost = escaped(text) + (lines.length ? 2 : 0);
        if (used + cost > textBudget) {
          // Always return part of one line so the reader can make progress;
          // the rest of it stays reachable through nextStartChar.
          if (!lines.length && textBudget > 0) {
            let length = Math.min(body.length, textBudget);
            while (length > 0 && escaped(prefix + body.slice(0, length)) > textBudget) length -= 1;
            // Do not split a surrogate pair.
            if (length > 0 && /[\uDC00-\uDFFF]/.test(body[length] ?? '')) length -= 1;
            if (length > 0) {
              lines.push(prefix + body.slice(0, length));
              endLine = line;
              nextStartChar = offset + length;
            }
          }
          break;
        }
        lines.push(text);
        used += cost;
        endLine = line;
      }
      if (!lines.length) throw noBudget();
      return JSON.stringify(build(endLine, lines.join('\n'), nextStartChar));
    },
  };

  const searchPage = {
    definition: PROJECT_SEARCH_PAGE_TOOL,
    async run(rawArgs, { maxChars, signal } = {}) {
      const args = asArgs(rawArgs);
      const query = String(args.query ?? '').trim();
      if (!query) throw new Error('query is required');
      const limit = intArg(args.limit, 'limit', {
        max: MAX_SEARCH_LIMIT,
        fallback: DEFAULT_SEARCH_LIMIT,
      });
      const single = args.page === undefined || args.page === null ? null : pageArg(args.page);
      throwIfAborted(signal);

      const hits = [];
      const unreadable = [];
      const perPage = [];
      const collect = (page, sentences) => {
        const ranked = rankPageLines(sentences, query);
        if (ranked.length) perPage.push({ page: page.page, matches: ranked.length });
        for (const { line, score } of ranked) {
          hits.push({ page: page.page, line, score, text: sentences[line - 1] });
        }
      };
      if (single) {
        const { sentences } = await loadSentences(single, signal);
        collect(single, sentences);
      } else {
        const loadedPages = await parallelMap(list, SEARCH_LOAD_CONCURRENCY, async (page) => {
          try {
            return { page, ...(await loadSentences(page, signal)) };
          } catch (error) {
            throwIfAborted(signal);
            return { page, error: clip(error?.message ?? error, ERROR_CHARS) || 'unreadable' };
          }
        });
        for (const entry of loadedPages) {
          if (entry.error) {
            unreadable.push({
              page: entry.page.page,
              title: titleOf(entry.page),
              error: entry.error,
            });
          } else collect(entry.page, entry.sentences);
        }
      }
      // Best first; ties keep page, then line order.
      hits.sort((a, b) => b.score - a.score || a.page - b.page || a.line - b.line);
      const matches = hits.slice(0, limit).map(({ page, line, text }) => ({
        page,
        line,
        text: clip(text, MAX_HIT_CHARS),
      }));
      const build = (count) => ({
        kind: 'page_search',
        query: clip(query, QUESTION_CHARS),
        ...(single ? { page: single.page, title: titleOf(single) } : { scope: 'all pages' }),
        totalMatches: hits.length,
        ...(single ? {} : { matchesByPage: perPage }),
        matches: matches.slice(0, count),
        ...(count < matches.length ? { truncated: true } : {}),
        ...(unreadable.length ? { unreadable } : {}),
        note: hits.length ? SEARCH_NOTE : 'No line matched; try other keywords.',
      });
      const budget = resolveBudget(maxChars);
      for (let count = matches.length; count >= 0; count -= 1) {
        const json = JSON.stringify(build(count));
        if (json.length <= budget) return json;
      }
      throw noBudget();
    },
  };

  const askPages = {
    definition: ASK_PAGES_TOOL,
    async run(rawArgs, { maxChars, signal } = {}) {
      const args = asArgs(rawArgs);
      const question = clip(args.question, QUESTION_CHARS);
      if (!question) throw new Error('question is required');
      let subset = list;
      if (args.pages !== undefined && args.pages !== null) {
        if (!Array.isArray(args.pages)) throw new Error('pages must be an array of page numbers');
        if (args.pages.length) {
          const wanted = new Set(args.pages.map((value) => pageArg(value).page));
          subset = list.filter((page) => wanted.has(page.page));
        }
      }
      throwIfAborted(signal);
      const results = await scan({ question, pages: subset, signal });
      throwIfAborted(signal);
      const build = (text) => ({
        kind: 'page_scan',
        question,
        pagesScanned: subset.length,
        note: SCAN_NOTE,
        results: text,
      });
      const budget = resolveBudget(maxChars);
      // Measure the envelope with an escaped-text allowance for newlines and quotes.
      let textBudget = budget - JSON.stringify(build('')).length;
      while (textBudget > 0) {
        const json = JSON.stringify(build(formatScanResults(results, { maxChars: textBudget })));
        if (json.length <= budget) return json;
        textBudget -= Math.max(1, json.length - budget);
      }
      throw noBudget();
    },
  };

  return typeof scan === 'function' ? [readPage, searchPage, askPages] : [readPage, searchPage];
}

const codedError = (message, code) => Object.assign(new Error(message), { code });

/**
 * The project chat's highlight tool: validates a page line range against the
 * page's text and returns the range to record, with the cited lines copied in
 * (`excerpt`) so the event shows them even after the page changes or closes.
 * Error codes are CHAT_TOOL_OUTCOMES values.
 * @param {object} input
 * @param {ScanPage[]} input.pages Project pages, numbered as in the overview.
 * @param {function(ScanPage): Promise<LoadedPage>} input.loadPage Same cached reader as the page tools.
 * @returns {{definition: object, resolve: function(object, {signal?: AbortSignal}=): Promise<{
 *   page: number, pageUrl: string, pageTitle: string, startLine: number, endLine: number,
 *   label: string, excerpt: string[]}>}}
 */
export function createProjectHighlightTool({ pages, loadPage }) {
  if (typeof loadPage !== 'function') throw new Error('loadPage is required');
  const byNumber = new Map(
    (Array.isArray(pages) ? pages : [])
      .filter((page) => page && Number.isInteger(page.page))
      .map((page) => [page.page, page]),
  );
  return {
    definition: PROJECT_HIGHLIGHT_TOOL,
    async resolve(rawArgs, { signal } = {}) {
      const args = asArgs(rawArgs);
      const page = byNumber.get(Number(args.page));
      if (typeof args.page === 'boolean' || !page) {
        throw codedError(
          `page ${String(args.page)} is not a project page; ${validRange([...byNumber.keys()])}`,
          CHAT_TOOL_OUTCOMES.INVALID_ARGUMENTS,
        );
      }
      const startLine = Number(args.start_line);
      const endLine = Number(args.end_line);
      if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) {
        throw codedError(
          'start_line and end_line must be integers',
          CHAT_TOOL_OUTCOMES.INVALID_ARGUMENTS,
        );
      }
      throwIfAborted(signal);
      const sentences = sentencesOf(await loadPage(page));
      throwIfAborted(signal);
      if (!sentences.length) {
        throw codedError(`page ${page.page} has no readable text`, CHAT_TOOL_OUTCOMES.TOOL_FAILED);
      }
      if (startLine < 1 || endLine < startLine || endLine > sentences.length) {
        throw codedError(
          `line range must be between 1 and ${sentences.length} for page ${page.page}`,
          CHAT_TOOL_OUTCOMES.OUT_OF_RANGE,
        );
      }
      if (endLine - startLine + 1 > MAX_PAGE_HIGHLIGHT_LINES) {
        throw codedError(
          `a highlight covers at most ${MAX_PAGE_HIGHLIGHT_LINES} lines; highlight the key lines only`,
          CHAT_TOOL_OUTCOMES.OUT_OF_RANGE,
        );
      }
      const excerpt = [];
      let used = 0;
      for (const line of sentences.slice(startLine - 1, endLine)) {
        const text = line.replace(/\s+/g, ' ').trim();
        if (used + text.length > MAX_EXCERPT_CHARS) {
          excerpt.push(clip(text, Math.max(1, MAX_EXCERPT_CHARS - used)));
          break;
        }
        excerpt.push(text);
        used += text.length;
      }
      return {
        page: page.page,
        pageUrl: page.url,
        pageTitle: titleOf(page),
        startLine,
        endLine,
        label: typeof args.label === 'string' ? clip(args.label, TITLE_CHARS) : '',
        excerpt,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Overview (the project chat's data message)
// ---------------------------------------------------------------------------

const OVERVIEW_HEADER =
  'PROJECT PAGES\nThis project is a set of web pages. Whole pages are not included here: the PAGE SCAN below quotes the lines relevant to the current question, and read_page and search_page reach the rest, using the page numbers below.';

const SCAN_MODE_LABELS = Object.freeze({
  [PAGE_SCAN_MODES.LLM]:
    'a language model read every line of each page and pointed to the lines relevant to the question; those lines are quoted below',
  [PAGE_SCAN_MODES.DECISION]:
    'a decision model judged every passage of each page; relevance comes from its probabilities, there are no summaries, notes give each passage probability, and the passages are quoted below',
});

const NO_SCAN_TEXT =
  'No page scan ran for this question. Call ask_pages with the question to find which pages are relevant before reading.';

const TREE_HEADING =
  'MERGED TOPIC TREE (optional extra)\nThe tools search_topics, get_topic, read_topic_content and get_claim_sources are available. They cover only the articles merged into this tree, which may not include every page; the page tools above always work.';

const NO_TREE_TEXT =
  'MERGED TOPIC TREE\nNot available in this chat: no topic tree tools are offered. Use the page tools.';

const OVERVIEW_GUIDANCE = [
  'How to use it:',
  '- Start from the PAGE SCAN: its quoted lines (">") are the page text, so use every relevant detail in them (numbers, names, dates, conditions, exceptions). Call read_page around them when you need surrounding context, and for findings whose lines are not quoted.',
  '- Read narrowly beyond that; do not read whole pages unless the question needs it. search_page without page searches all pages by keywords.',
  '- Use ask_pages only for a different sub-question than the current message.',
  '- Call highlight_span (page, start_line, end_line) for each passage your answer relies on, after reading it; the user sees these as quoted page excerpts.',
  '- Cite as "Page title, lines N–M" using page line numbers from read_page or search_page.',
].join('\n');

// Smallest share of the overview kept for the page list when the scan is long.
const MIN_PAGE_LIST_CHARS = 400;
const PAGE_LIST_SHARE = 0.2;

function listSection(heading, items, format, budget, more) {
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
  if (shown < items.length) lines.push(`- ...and ${items.length - shown} more ${more}`);
  return lines.join('\n');
}

const hardClip = (text, max) =>
  text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;

/**
 * The project chat's overview text: header, numbered page list, unreadable
 * pages, the per-page scan for the current question (or a pointer to
 * ask_pages), the optional merged-tree overview, and usage guidance. It fits
 * `maxChars`; the scan section takes priority over a long page list.
 * @param {object} input
 * @param {ScanPage[]} input.pages
 * @param {Array<{page?: number, title?: string, url?: string, reason?: string}>} [input.unreadablePages]
 * @param {string} [input.treeOverview] The merged-tree preamble, when a tree exists.
 * @param {string} [input.scanText] formatScanResults text for the current question.
 * @param {'llm'|'decision'} [input.scanMode] How the scan was produced.
 * @param {number} input.maxChars
 * @returns {string}
 */
export function buildProjectPagesOverview({
  pages,
  unreadablePages = [],
  treeOverview = '',
  scanText = '',
  scanMode,
  maxChars,
}) {
  const budget = resolveBudget(maxChars);
  const list = (Array.isArray(pages) ? pages : []).filter(Boolean);
  const unreadable = (Array.isArray(unreadablePages) ? unreadablePages : []).filter(Boolean);
  const where = (page) => (page.url ? ` <${clip(page.url, URL_CHARS)}>` : '');
  const scan = String(scanText || '').trim();
  const tree = String(treeOverview || '').trim();

  const modeLabel = SCAN_MODE_LABELS[scanMode];
  let scanHead = scan
    ? `PAGE SCAN\nProduced for the current message by a per-page pass${modeLabel ? ` (${modeLabel})` : ''}. Lines starting with ">" quote the page verbatim as "line: text"; a quoted line ending in "…" was shortened. "Nothing relevant" means the scan found nothing there.`
    : `PAGE SCAN\n${NO_SCAN_TEXT}`;

  const join = (parts) => parts.filter(Boolean).join('\n\n');
  let header = OVERVIEW_HEADER;
  let treeHeading = tree ? TREE_HEADING : NO_TREE_TEXT;
  let guidance = OVERVIEW_GUIDANCE;
  const fixedText = () => join([header, scanHead, treeHeading, guidance]);
  // Explanations must not consume the space needed for the scan itself.
  const compact = fixedText().length > budget / 2;
  if (compact) {
    header = 'PROJECT PAGES';
    scanHead = scan
      ? 'PAGE SCAN\nFor the current question. ">" quotes numbered page lines; "…" marks shortened text.'
      : `PAGE SCAN\n${NO_SCAN_TEXT}`;
    treeHeading = tree ? 'MERGED TOPIC TREE (optional extra)' : '';
    guidance =
      'Use scan quotes; read_page for context. Use ask_pages for different questions. Call highlight_span for supporting passages; cite page titles and line numbers.';
    if (fixedText().length > budget / 2) {
      header = '';
      scanHead = scan ? 'PAGE SCAN' : scanHead;
      treeHeading = '';
      guidance = '';
    }
  }
  const fixed = fixedText();
  let remaining = Math.max(0, budget - fixed.length - 16);

  const fullList = listSection(
    `Pages (${list.length}):`,
    list,
    (page) => `${page.page}. ${titleOf(page)}${where(page)}`,
    Infinity,
    '',
  );
  const pagesReserve = Math.min(
    fullList.length,
    compact
      ? Math.floor(remaining * PAGE_LIST_SHARE)
      : Math.max(MIN_PAGE_LIST_CHARS, Math.floor(remaining * PAGE_LIST_SHARE)),
  );

  const scanBody = scan
    ? hardClip(scan, Math.max(0, Math.min(scan.length, remaining - pagesReserve)))
    : '';
  remaining = Math.max(0, remaining - scanBody.length - 2);

  const unreadableSection = listSection(
    `Pages that cannot be read (${unreadable.length}):`,
    unreadable,
    (page) =>
      `- ${Number.isInteger(page.page) ? `${page.page}. ` : ''}${titleOf(page)}${where(page)}: ${clip(page.reason || 'not available', ERROR_CHARS)}`,
    Math.floor(Math.max(0, remaining - pagesReserve) * 0.4),
    'not listed',
  );
  remaining = Math.max(0, remaining - unreadableSection.length - 2);

  const treeBody = tree
    ? hardClip(tree, Math.max(0, Math.min(tree.length, remaining - pagesReserve)))
    : '';
  remaining = Math.max(0, remaining - treeBody.length - 2);

  const pageSection =
    listSection(
      `Pages (${list.length}):`,
      list,
      (page) => `${page.page}. ${titleOf(page)}${where(page)}`,
      Math.max(remaining, 1),
      'not listed (use search_page or ask_pages to reach them)',
    ) || 'Pages (0): this project has no pages.';

  const scanSection = scanBody ? `${scanHead}\n${scanBody}` : scanHead;
  const text = join([
    header,
    // A minimum-size page entry can overflow its reserve; keep findings first
    // in compact overviews so the final clip cannot discard them.
    ...(compact
      ? [scanSection, pageSection, unreadableSection]
      : [pageSection, unreadableSection, scanSection]),
    tree ? join([treeHeading, treeBody]) : treeHeading,
    guidance,
  ]);
  return hardClip(text, budget);
}
