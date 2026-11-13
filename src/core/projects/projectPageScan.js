// Per-page scan for the project chat. Code, not the chat model, walks the
// project's pages and asks a small judge, one page at a time, whether and where
// the page helps answer the user's question. Every line of every page is
// judged (by default), and the lines the judge points to are quoted verbatim in
// the chat's overview, so small details reach the orchestrating model as page
// text rather than as a summary. Two interchangeable judges exist: the
// completion LLM (reads numbered chunks, replies with small JSON) and a
// decision model (one typed question per passage, mapped to relevance by
// thresholds in code).

import { chunkNumberedArticle } from '../../chat/articleChunking.js';
import { choice, decisionRequestFits } from '../llm/decisionClient.js';
import { executeDecisionWithRetry } from '../llm/decisionRetry.js';
import { makeAbortError, sleepWithAbort } from '../llm/abortSignals.js';
import { parallelMap } from '../llm/concurrency.js';
import { LLM_TASK_TYPES } from '../metrics/llm.js';
import { tokenize } from '../search/tokenize.js';
import { fitTextToChars } from '../pipeline/textFit.js';
import {
  PAGE_SCAN_SYSTEM_PROMPT,
  PASSAGE_CHOICES,
  PASSAGE_HELPS_OPTION,
  PASSAGE_HELPS_THRESHOLD,
  PASSAGE_UNRELATED_THRESHOLD,
  buildPageScanDataMessage,
  buildPageScanQuestionMessage,
  buildPassageState,
  passageQuestion,
} from './projectPageScanPrompts.js';

/** @typedef {{page: number, title: string, url: string}} ScanPage */
/** @typedef {{sentences: string[], truncated?: boolean, topics?: string[]}} LoadedPage */
/**
 * @typedef {{startLine: number, endLine: number, note: string, lines?: string[]}} ScanFinding
 *   `lines`: the page's text of lines startLine..endLine, set on scan results.
 */
/**
 * @typedef {{page: number, title: string, url: string,
 *   relevance: 'high'|'low'|'none'|'unknown', summary: string, findings: ScanFinding[],
 *   totalLines: number, topics: string[], scannedThroughLine?: number,
 *   scannedLines?: number, error?: string}} PageScanResult
 *   `scannedThroughLine`: the completion judge read lines 1..N only.
 *   `scannedLines`: the decision judge judged passages covering this many lines,
 *   chosen by keyword overlap, not a prefix.
 */
/**
 * @typedef {{relevance: 'high'|'low'|'none', summary: string,
 *   findings: Array<{startLine: number, endLine: number, note?: string}>,
 *   scannedThroughLine?: number, scannedLines?: number}} PageVerdict
 *   Findings in priority order (most useful first); the scan caps, then sorts them.
 */

/** Ids of the scan strategies; the overview names the one used. */
export const PAGE_SCAN_MODES = Object.freeze({ LLM: 'llm', DECISION: 'decision' });

export const PAGE_SCAN_CONCURRENCY = 3;
export const MAX_FINDINGS_PER_PAGE = 24;
export const FINDING_NOTE_MAX_CHARS = 200;
export const SUMMARY_MAX_CHARS = 300;
export const ERROR_MAX_CHARS = 160;
const MAX_TOPICS_KEPT = 20;
const TOPIC_MAX_CHARS = 80;

// Chunks the completion judge reads per page: all of them, so no detail is
// missed past a fixed prefix. A finite cap reports `scannedThroughLine`.
export const DEFAULT_MAX_CHUNKS_PER_PAGE = Infinity;

// Decision judge passages: consecutive whole sentences, roughly this long.
export const PASSAGE_MIN_CHARS = 800;
export const PASSAGE_MAX_CHARS = 1500;
// Passages judged per page: all of them by default. With a finite cap a longer
// page keeps its lead passage plus the passages that share the most (rare)
// words with the question; skipped passages are reported through
// `scannedLines`, never as "unrelated".
export const MAX_PASSAGES_PER_PAGE = Infinity;
export const PASSAGES_PER_REQUEST = 8;
// Smallest passage text kept when shrinking one question to fit the context window.
const MIN_PASSAGE_CHARS_WHEN_SHRINKING = 120;
const QUOTE_CHARS = 90;
// Low-relevance pages report this many best passages as findings.
const LOW_FINDINGS = 2;

const RELEVANCE_RANK = Object.freeze({ none: 0, low: 1, high: 2 });

/**
 * @param {unknown} value
 * @returns {boolean} A positive integer, or Infinity for "no cap".
 */
const isCap = (value) => value === Infinity || (Number.isInteger(value) && value >= 1);

/**
 * Earlier user questions for the judge, oldest first, without blanks.
 * @param {unknown} value
 * @returns {string[]}
 */
const cleanEarlier = (value) =>
  (Array.isArray(value) ? value : []).map((text) => String(text ?? '').trim()).filter(Boolean);

const clip = (text, max) => {
  const flat = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
};

/**
 * The abort reason as an Error, so callers can tell a cancelled scan apart.
 * @param {AbortSignal} [signal]
 * @returns {Error}
 */
function abortError(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : makeAbortError('The page scan was cancelled.');
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal);
}

/**
 * Settle `promise`, but reject as soon as `signal` aborts.
 * @template T
 * @param {Promise<T>} promise
 * @param {AbortSignal} [signal]
 * @returns {Promise<T>}
 */
function raceAbort(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    if (signal.aborted) {
      onAbort();
      promise.catch(() => {});
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

const sentencesOf = (loaded) =>
  Array.isArray(loaded?.sentences) ? loaded.sentences.map((s) => String(s ?? '')) : [];

function toLine(value) {
  if (typeof value === 'boolean' || value === null || value === undefined || value === '') {
    return null;
  }
  const number = Number(typeof value === 'string' ? value.trim() : value);
  return Number.isInteger(number) ? number : null;
}

/**
 * Validates findings against the page's real lines: clamps ranges into
 * [minLine, maxLine], drops ranges outside it, removes duplicates, keeps the
 * first `cap` in the given (priority) order, then sorts them by line.
 * @param {Array<{startLine: *, endLine?: *, note?: *}>} findings
 * @param {{minLine?: number, maxLine: number, cap?: number}} bounds
 * @returns {ScanFinding[]}
 */
export function normalizeFindings(findings, { minLine = 1, maxLine, cap = MAX_FINDINGS_PER_PAGE }) {
  const kept = [];
  const seen = new Set();
  for (const finding of Array.isArray(findings) ? findings : []) {
    if (kept.length >= cap) break;
    let start = toLine(finding?.startLine);
    let end = toLine(finding?.endLine ?? finding?.startLine);
    if (start === null || end === null) continue;
    if (start > end) [start, end] = [end, start];
    if (end < minLine || start > maxLine) continue;
    start = Math.max(start, minLine);
    end = Math.min(end, maxLine);
    const key = `${start}:${end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push({
      startLine: start,
      endLine: end,
      note: clip(finding?.note, FINDING_NOTE_MAX_CHARS),
    });
  }
  return kept.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
}

function normalizeTopics(topics) {
  const seen = new Set();
  const kept = [];
  for (const topic of Array.isArray(topics) ? topics : []) {
    const name = clip(typeof topic === 'string' ? topic : '', TOPIC_MAX_CHARS);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    kept.push(name);
    if (kept.length >= MAX_TOPICS_KEPT) break;
  }
  return kept;
}

/**
 * @param {ScanPage} page
 * @param {LoadedPage|undefined} loaded
 * @param {PageVerdict} verdict
 * @returns {PageScanResult}
 */
function toResult(page, loaded, verdict) {
  const totalLines = sentencesOf(loaded).length;
  const relevance = verdict?.relevance;
  if (!Object.hasOwn(RELEVANCE_RANK, relevance)) {
    throw new Error(`the judge returned an invalid relevance (${String(relevance)})`);
  }
  const none = relevance === 'none';
  const sentences = sentencesOf(loaded);
  const through = toLine(verdict.scannedThroughLine);
  const scannedLines = toLine(verdict.scannedLines);
  return {
    ...pageHead(page),
    relevance,
    summary: none ? '' : clip(verdict.summary, SUMMARY_MAX_CHARS),
    findings: none
      ? []
      : normalizeFindings(verdict.findings, { maxLine: totalLines }).map((finding) => ({
          ...finding,
          lines: sentences.slice(finding.startLine - 1, finding.endLine),
        })),
    totalLines,
    topics: normalizeTopics(loaded?.topics),
    ...(through !== null && through >= 1 && through < totalLines
      ? { scannedThroughLine: through }
      : {}),
    ...(scannedLines !== null && scannedLines >= 0 && scannedLines < totalLines
      ? { scannedLines }
      : {}),
  };
}

const pageHead = (page) => ({
  page: page?.page,
  title: String(page?.title || ''),
  url: String(page?.url || ''),
});

/**
 * Scans pages for one question with bounded concurrency. A page whose load or
 * judgment fails becomes relevance 'unknown' with a short `error`, and the
 * scan continues; an abort of `signal` rejects the whole scan with its reason.
 * @param {object} input
 * @param {ScanPage[]} input.pages
 * @param {string} input.question
 * @param {function(ScanPage): Promise<LoadedPage>} input.loadPage
 * @param {function({page: ScanPage, loaded: LoadedPage, question: string,
 *   earlierQuestions: string[], signal?: AbortSignal}): Promise<PageVerdict>} input.judge
 * @param {string[]} [input.earlierQuestions] Earlier user questions of the chat,
 *   oldest first, so the judge can resolve references in a follow-up.
 * @param {number} [input.concurrency] Pages scanned at once.
 * @param {AbortSignal} [input.signal]
 * @param {function({done: number, total: number, page: number, result: PageScanResult}): void}
 *   [input.onProgress] Called after each page settles; its errors are ignored.
 * @returns {Promise<PageScanResult[]>} In `pages` order.
 */
export async function scanProjectPages({
  pages,
  question,
  loadPage,
  judge,
  earlierQuestions,
  concurrency = PAGE_SCAN_CONCURRENCY,
  signal,
  onProgress,
}) {
  if (!Array.isArray(pages)) throw new Error('pages must be an array');
  if (typeof loadPage !== 'function') throw new Error('loadPage is required');
  if (typeof judge !== 'function') throw new Error('judge is required');
  const limit = Number.isInteger(concurrency) && concurrency > 0 ? concurrency : 1;
  throwIfAborted(signal);
  const total = pages.length;
  let done = 0;
  const earlier = cleanEarlier(earlierQuestions);

  const scanOne = async (page) => {
    let loaded;
    let result;
    try {
      loaded = await loadPage(page);
      throwIfAborted(signal);
      if (!sentencesOf(loaded).length) throw new Error('the page has no readable text');
      const verdict = await judge({
        page,
        loaded,
        question: String(question ?? ''),
        earlierQuestions: earlier,
        signal,
      });
      throwIfAborted(signal);
      result = toResult(page, loaded, verdict);
    } catch (error) {
      if (signal?.aborted) throw abortError(signal);
      result = {
        ...pageHead(page),
        relevance: 'unknown',
        summary: '',
        findings: [],
        totalLines: sentencesOf(loaded).length,
        topics: normalizeTopics(loaded?.topics),
        error: clip(error?.message ?? error, ERROR_MAX_CHARS) || 'scan failed',
      };
    }
    done += 1;
    try {
      onProgress?.({ done, total, page: page?.page, result });
    } catch (_) {
      // Progress reporting must not fail the scan.
    }
    return result;
  };

  return raceAbort(parallelMap(pages, limit, scanOne), signal);
}

// ---------------------------------------------------------------------------
// Completion LLM judge
// ---------------------------------------------------------------------------

/**
 * Text inside the first Markdown code fence, or the input when there is none.
 * @param {string} text
 */
function stripFences(text) {
  const fenced = /```[a-z]*\s*([\s\S]*?)```/i.exec(text);
  return fenced ? fenced[1].trim() : text;
}

/**
 * Balanced `{...}` substrings in order of their opening brace, honouring strings.
 * @param {string} text
 */
function* objectCandidates(text) {
  for (let open = text.indexOf('{'); open >= 0; open = text.indexOf('{', open + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = open; index < text.length; index++) {
      const char = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
      } else if (char === '"') inString = true;
      else if (char === '{') depth++;
      else if (char === '}' && --depth === 0) {
        yield text.slice(open, index + 1);
        break;
      }
    }
  }
}

/**
 * Parses a judge reply defensively: code fences and surrounding prose are
 * ignored, bad line numbers are dropped. A reply without a valid relevance is
 * an error, never "none".
 * @param {unknown} content Raw completion text.
 * @returns {PageVerdict}
 */
export function parseScanReply(content) {
  const text = stripFences(String(content ?? '').trim());
  // The first object with a relevance field wins; any other object is a fallback.
  let value;
  for (const candidate of [text, ...objectCandidates(text)]) {
    let parsed;
    try {
      parsed = JSON.parse(candidate);
    } catch (_) {
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    value ??= parsed;
    if (Object.hasOwn(parsed, 'relevance')) {
      value = parsed;
      break;
    }
  }
  if (!value) throw new Error('the scan reply is not a JSON object');
  const relevance = String(value.relevance ?? '')
    .trim()
    .toLowerCase();
  if (!Object.hasOwn(RELEVANCE_RANK, relevance)) {
    throw new Error('the scan reply has no valid relevance');
  }
  const findings = (Array.isArray(value.findings) ? value.findings : []).map((finding) => ({
    startLine: finding?.start_line ?? finding?.startLine,
    endLine: finding?.end_line ?? finding?.endLine ?? finding?.start_line ?? finding?.startLine,
    note: typeof finding?.note === 'string' ? finding.note : '',
  }));
  return {
    relevance,
    summary: typeof value.summary === 'string' ? value.summary : '',
    findings,
  };
}

/**
 * Merges chunk verdicts: the highest relevance wins; summaries of the chunks
 * at that level are joined; findings of high chunks come before those of low ones.
 * @param {PageVerdict[]} verdicts
 * @returns {PageVerdict}
 */
export function mergeChunkVerdicts(verdicts) {
  const best = verdicts.reduce(
    (top, verdict) => Math.max(top, RELEVANCE_RANK[verdict.relevance]),
    0,
  );
  const relevance = Object.keys(RELEVANCE_RANK).find((key) => RELEVANCE_RANK[key] === best);
  if (relevance === 'none') return { relevance, summary: '', findings: [] };
  const summaries = [
    ...new Set(
      verdicts
        .filter((verdict) => RELEVANCE_RANK[verdict.relevance] === best)
        .map((verdict) => clip(verdict.summary, SUMMARY_MAX_CHARS))
        .filter(Boolean),
    ),
  ];
  const findings = [2, 1].flatMap((rank) =>
    verdicts
      .filter((verdict) => RELEVANCE_RANK[verdict.relevance] === rank)
      .flatMap((v) => v.findings),
  );
  return { relevance, summary: clip(summaries.join(' '), SUMMARY_MAX_CHARS), findings };
}

/**
 * Judge that asks the completion LLM about each numbered chunk of a page.
 * @param {object} options
 * @param {function({messages: object[], taskType: string, signal?: AbortSignal}):
 *   Promise<{ok: boolean, content?: string, error?: string}>} options.complete
 * @param {number} options.maxChunkChars Characters per numbered chunk.
 * @param {number} [options.maxChunksPerPage] Chunks read per page (default: all);
 *   with a finite cap later lines are not scanned and `scannedThroughLine` says
 *   where reading stopped.
 * @returns {function({page: ScanPage, loaded: LoadedPage, question: string,
 *   earlierQuestions?: string[], signal?: AbortSignal}): Promise<PageVerdict>}
 */
export function createLlmPageJudge({
  complete,
  maxChunkChars,
  maxChunksPerPage = DEFAULT_MAX_CHUNKS_PER_PAGE,
}) {
  if (typeof complete !== 'function') throw new Error('complete is required');
  if (!isCap(maxChunksPerPage)) {
    throw new Error('maxChunksPerPage must be a positive integer or Infinity');
  }
  return async function judgeWithLlm({ page, loaded, question, earlierQuestions, signal }) {
    const earlier = cleanEarlier(earlierQuestions);
    const sentences = sentencesOf(loaded);
    const chunks = chunkNumberedArticle(sentences, maxChunkChars);
    if (!chunks.length) throw new Error('the page has no readable text');
    const scanned = chunks.slice(0, maxChunksPerPage);
    const verdicts = [];
    for (const chunk of scanned) {
      throwIfAborted(signal);
      const response = await complete({
        messages: [
          { role: 'system', content: PAGE_SCAN_SYSTEM_PROMPT },
          { role: 'user', content: buildPageScanDataMessage(page, chunk, sentences.length) },
          { role: 'user', content: buildPageScanQuestionMessage(question, earlier) },
        ],
        taskType: LLM_TASK_TYPES.CHAT_PAGE_SCAN,
        signal,
      });
      throwIfAborted(signal);
      if (!response?.ok) {
        throw new Error(clip(response?.error || 'the scan request failed', ERROR_MAX_CHARS));
      }
      const verdict = parseScanReply(response.content);
      verdicts.push({
        ...verdict,
        findings: normalizeFindings(verdict.findings, {
          minLine: chunk.startLine,
          maxLine: chunk.endLine,
          cap: Infinity,
        }),
      });
    }
    return {
      ...mergeChunkVerdicts(verdicts),
      ...(scanned.length < chunks.length ? { scannedThroughLine: scanned.at(-1).endLine } : {}),
    };
  };
}

// ---------------------------------------------------------------------------
// Decision judge
// ---------------------------------------------------------------------------

/**
 * Cuts a page into consecutive passages of whole sentences. A passage closes
 * once it reaches `minChars` or when the next sentence would push it past
 * `maxChars`; a single sentence longer than `maxChars` is shortened in the middle.
 * @param {string[]} sentences
 * @param {{minChars?: number, maxChars?: number}} [options]
 * @returns {Array<{startLine: number, endLine: number, text: string}>} 1-based lines.
 */
export function buildPagePassages(
  sentences,
  { minChars = PASSAGE_MIN_CHARS, maxChars = PASSAGE_MAX_CHARS } = {},
) {
  const passages = [];
  let current = null;
  const flush = () => {
    if (current) passages.push({ ...current, text: fitTextToChars(current.text, maxChars) });
    current = null;
  };
  (Array.isArray(sentences) ? sentences : []).forEach((sentence, index) => {
    const text = String(sentence ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) return;
    if (
      current &&
      (current.text.length >= minChars || current.text.length + 1 + text.length > maxChars)
    ) {
      flush();
    }
    if (!current) current = { startLine: index + 1, endLine: index + 1, text };
    else {
      current.text += ` ${text}`;
      current.endLine = index + 1;
    }
  });
  flush();
  return passages;
}

/**
 * Keeps at most `cap` passages: the lead passage plus those sharing the most
 * question words, weighted by how rare each word is across the page's
 * passages (so words found everywhere count for nothing). Page order is kept.
 * @param {Array<{text: string}>} passages
 * @param {string} question
 * @param {number} cap
 * @returns {number[]} Indexes of the kept passages, ascending.
 */
export function selectPassages(passages, question, cap = MAX_PASSAGES_PER_PAGE) {
  const all = passages.map((_, index) => index);
  if (passages.length <= cap) return all;
  if (cap < 1) return [];
  const wanted = [...new Set(tokenize(question))];
  const words = passages.map((passage) => new Set(tokenize(passage.text)));
  const weight = Object.fromEntries(
    wanted.map((word) => {
      const df = words.filter((set) => set.has(word)).length;
      return [word, df ? Math.log(passages.length / df) : 0];
    }),
  );
  const score = (index) =>
    wanted.reduce((sum, w) => sum + (words[index].has(w) ? weight[w] : 0), 0);
  const ranked = all
    .slice(1)
    .map((index) => ({ index, score: score(index) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, cap - 1)
    .map((entry) => entry.index);
  return [0, ...ranked].sort((a, b) => a - b);
}

/**
 * P(helps_answer) for one question, validated like the topic splitter's answers.
 * @param {object} response Decision server response.
 * @param {string} id Question id.
 * @returns {number}
 */
export function readHelpsProbability(response, id) {
  const answer = response?.answers?.[id];
  const values = Object.keys(PASSAGE_CHOICES).map((name) => answer?.probabilities?.[name]);
  if (
    !Object.hasOwn(PASSAGE_CHOICES, answer?.choice) ||
    !values.every((value) => Number.isFinite(value) && value >= 0 && value <= 1) ||
    Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) > 0.001
  ) {
    throw new Error(`invalid decision answer for passage ${id}`);
  }
  return answer.probabilities[PASSAGE_HELPS_OPTION];
}

const quoteNote = (passages, probability) =>
  `"${clip(passages[0].text, QUOTE_CHARS)}" (p=${probability.toFixed(2)})`;

/**
 * Maps passage probabilities to a page verdict (the truth table):
 * - any passage with p >= PASSAGE_HELPS_THRESHOLD: relevance high; those passages
 *   are findings, adjacent ones merged;
 * - else the best p >= PASSAGE_UNRELATED_THRESHOLD: relevance low (unsettled), the
 *   best LOW_FINDINGS passages in that band are findings;
 * - else relevance none.
 * @param {Array<{index: number, startLine: number, endLine: number, text: string,
 *   probability: number}>} judged In page order; `index` is the page passage index.
 * @returns {PageVerdict}
 */
export function verdictFromProbabilities(judged) {
  const high = judged.filter((item) => item.probability >= PASSAGE_HELPS_THRESHOLD);
  if (high.length) {
    const groups = [];
    for (const item of high) {
      const last = groups.at(-1);
      if (last && last.at(-1).index + 1 === item.index) last.push(item);
      else groups.push([item]);
    }
    const findings = groups
      .map((group) => ({ group, best: Math.max(...group.map((item) => item.probability)) }))
      .sort((a, b) => b.best - a.best || a.group[0].index - b.group[0].index)
      .map(({ group, best }) => ({
        startLine: group[0].startLine,
        endLine: group.at(-1).endLine,
        note: quoteNote(group, best),
      }));
    return { relevance: 'high', summary: '', findings };
  }
  const unsettled = judged
    .filter((item) => item.probability >= PASSAGE_UNRELATED_THRESHOLD)
    .sort((a, b) => b.probability - a.probability || a.index - b.index);
  if (!unsettled.length) return { relevance: 'none', summary: '', findings: [] };
  return {
    relevance: 'low',
    summary: '',
    findings: unsettled.slice(0, LOW_FINDINGS).map((item) => ({
      startLine: item.startLine,
      endLine: item.endLine,
      note: quoteNote([item], item.probability),
    })),
  };
}

/**
 * Judge that asks a decision model one question per passage: does it contain
 * information that helps answer the question. Code maps the probabilities to
 * relevance (see verdictFromProbabilities). Requests are sent one after another
 * per page (pages already run concurrently); each holds up to
 * PASSAGES_PER_REQUEST questions and is split further until it fits the
 * context window. An invalid or missing answer fails the page, never reads as "no".
 * @param {object} options
 * @param {function(object, Record<string, object>, {signal?: AbortSignal, taskType: string}):
 *   Promise<{answers: object}>} options.decide
 * @param {number} [options.contextWindowTokens] Decision provider context budget.
 * @param {number} [options.maxPassagesPerPage] Default: every passage.
 * @param {number} [options.passagesPerRequest]
 * @param {Function} [options.sleep] `(ms, signal)` retry backoff, injectable for tests.
 * @param {Function} [options.random] Retry jitter source.
 * @returns {function({page: ScanPage, loaded: LoadedPage, question: string,
 *   earlierQuestions?: string[], signal?: AbortSignal}): Promise<PageVerdict>}
 */
export function createDecisionPageJudge({
  decide,
  contextWindowTokens,
  maxPassagesPerPage = MAX_PASSAGES_PER_PAGE,
  passagesPerRequest = PASSAGES_PER_REQUEST,
  sleep = sleepWithAbort,
  random = Math.random,
}) {
  if (typeof decide !== 'function') throw new Error('decide is required');
  if (!isCap(maxPassagesPerPage)) {
    throw new Error('maxPassagesPerPage must be a positive integer or Infinity');
  }
  if (!Number.isInteger(passagesPerRequest) || passagesPerRequest < 1) {
    throw new Error('passagesPerRequest must be a positive integer');
  }

  const questionsFor = (items) =>
    Object.fromEntries(
      items.map((item) => [item.id, choice(passageQuestion(item.text), PASSAGE_CHOICES)]),
    );

  // Probabilities for `items`, in order. An oversized batch is halved; one
  // oversized question has its passage text shortened.
  async function decideItems(state, items, signal) {
    throwIfAborted(signal);
    let questions = questionsFor(items);
    if (!decisionRequestFits(state, questions, contextWindowTokens)) {
      if (items.length > 1) {
        const middle = Math.ceil(items.length / 2);
        const first = await decideItems(state, items.slice(0, middle), signal);
        return [...first, ...(await decideItems(state, items.slice(middle), signal))];
      }
      let cap = items[0].text.length;
      while (!decisionRequestFits(state, questions, contextWindowTokens)) {
        cap = Math.floor(cap / 2);
        if (cap < MIN_PASSAGE_CHARS_WHEN_SHRINKING) {
          throw new Error('the decision context window is too small for one passage question');
        }
        questions = questionsFor([{ ...items[0], text: fitTextToChars(items[0].text, cap) }]);
      }
    }
    const response = await executeDecisionWithRetry(
      () => decide(state, questions, { signal, taskType: LLM_TASK_TYPES.CHAT_PAGE_SCAN }),
      { signal, sleep, random },
    );
    throwIfAborted(signal);
    return items.map((item) => readHelpsProbability(response, item.id));
  }

  return async function judgeWithDecisions({ page, loaded, question, earlierQuestions, signal }) {
    const sentences = sentencesOf(loaded);
    const passages = buildPagePassages(sentences);
    if (!passages.length) throw new Error('the page has no readable text');
    const kept = selectPassages(passages, question, maxPassagesPerPage);
    const items = kept.map((index) => ({ ...passages[index], index, id: `p${index + 1}` }));
    const state = buildPassageState(question, page?.title, cleanEarlier(earlierQuestions));
    const probabilities = [];
    for (let start = 0; start < items.length; start += passagesPerRequest) {
      const batch = items.slice(start, start + passagesPerRequest);
      probabilities.push(...(await decideItems(state, batch, signal)));
    }
    const verdict = verdictFromProbabilities(
      items.map((item, position) => ({ ...item, probability: probabilities[position] })),
    );
    if (kept.length === passages.length) return verdict;
    const scannedLines = items.reduce((sum, item) => sum + item.endLine - item.startLine + 1, 0);
    return { ...verdict, scannedLines };
  };
}

// ---------------------------------------------------------------------------
// Model-facing text
// ---------------------------------------------------------------------------

const MAX_TOPICS_SHOWN = 8;
const TITLE_CHARS = 100;

const lineRange = ({ startLine, endLine }) =>
  startLine === endLine ? `line ${startLine}` : `lines ${startLine}–${endLine}`;

/**
 * "1–3, 5, 8–9" for page numbers.
 * @param {number[]} numbers
 */
function compactNumbers(numbers) {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const parts = [];
  for (let index = 0; index < sorted.length; index++) {
    let end = index;
    while (end + 1 < sorted.length && sorted[end + 1] === sorted[end] + 1) end++;
    parts.push(end === index ? `${sorted[index]}` : `${sorted[index]}–${sorted[end]}`);
    index = end;
  }
  return parts.join(', ');
}

function coverageNote(result) {
  if (result.scannedThroughLine) {
    return ` (scanned lines 1–${result.scannedThroughLine} of ${result.totalLines} only)`;
  }
  if (Number.isInteger(result.scannedLines)) {
    return ` (scanned ${result.scannedLines} of ${result.totalLines} lines, picked by keywords)`;
  }
  return '';
}

// Detail levels, most detailed first: 0 full (finding notes, plus the
// findings' page lines quoted verbatim as far as the quote quota allows);
// 1 without finding notes or quotes; 2 without topics; 3 without findings;
// 4 header lines only.
const DETAIL_LEVELS = 5;
// Longest stretch of one quoted page line; longer lines end in "…" and stay
// readable with read_page.
export const QUOTE_LINE_MAX_CHARS = 600;
// A quoted line cut by the quota keeps at least this much, or is left out.
const MIN_QUOTE_CHARS = 40;
const QUOTE_INDENT = '    > ';

/**
 * The quoted page lines of one finding, spending `quota.left` characters.
 * @param {ScanFinding} finding
 * @param {{left: number, cut: boolean}} quota Shared by all findings, in order.
 * @returns {string[]}
 */
function quoteFinding(finding, quota) {
  const text = Array.isArray(finding.lines) ? finding.lines : [];
  const out = [];
  for (let index = 0; index < text.length; index++) {
    const lineNumber = finding.startLine + index;
    const body = String(text[index] ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!body) continue;
    const prefix = `${QUOTE_INDENT}${lineNumber}: `;
    const full = `${prefix}${clip(body, QUOTE_LINE_MAX_CHARS)}`;
    if (full.length + 1 <= quota.left) {
      out.push(full);
      quota.left -= full.length + 1;
      continue;
    }
    const room = quota.left - prefix.length - 1;
    if (room >= MIN_QUOTE_CHARS) out.push(`${prefix}${clip(body, room)}`);
    quota.left = 0;
    quota.cut = true;
    break;
  }
  return out;
}

/**
 * @param {PageScanResult[]} results
 * @returns {number} Characters every finding quote would take with an unlimited quota.
 */
function fullQuoteChars(results) {
  const quota = { left: Number.MAX_SAFE_INTEGER, cut: false };
  for (const result of results) for (const finding of result.findings) quoteFinding(finding, quota);
  return Number.MAX_SAFE_INTEGER - quota.left;
}

function formatRelevant(result, level, quota) {
  const lines = [
    `Page ${result.page} "${clip(result.title || result.url || 'Untitled page', TITLE_CHARS)}" — relevance ${result.relevance}${coverageNote(result)}`,
  ];
  if (level < 4 && result.summary) lines.push(`  Summary: ${result.summary}`);
  if (level < 3 && result.findings.length) {
    if (level < 1) {
      for (const finding of result.findings) {
        lines.push(`  - ${lineRange(finding)}${finding.note ? `: ${finding.note}` : ''}`);
        if (quota) lines.push(...quoteFinding(finding, quota));
      }
    } else {
      lines.push(`  Findings: ${result.findings.map(lineRange).join(', ')}`);
    }
  }
  if (level < 2 && result.topics?.length) {
    const shown = result.topics.slice(0, MAX_TOPICS_SHOWN).join('; ');
    const more = result.topics.length - MAX_TOPICS_SHOWN;
    lines.push(`  Topics: ${shown}${more > 0 ? `; +${more} more` : ''}`);
  }
  return lines.join('\n');
}

const QUOTES_CUT_NOTE =
  'Quotes stop here for space: read the remaining finding lines with read_page.';

function formatFailures(failed, level) {
  if (!failed.length) return '';
  if (level >= 3) return `Could not scan pages: ${compactNumbers(failed.map((r) => r.page))}.`;
  return [
    'Could not scan:',
    ...failed.map(
      (r) =>
        `- page ${r.page} "${clip(r.title || r.url || 'Untitled page', TITLE_CHARS)}": ${r.error || 'unknown error'}`,
    ),
  ].join('\n');
}

/**
 * Model-facing text for scan results, within `maxChars`: relevant pages (high,
 * then low) with summary, findings with their page lines quoted verbatim, and
 * topics; one line naming pages with nothing relevant (partly scanned ones
 * listed apart, with their coverage, since their unread text may still be
 * relevant); then pages that could not be scanned. Quotes get whatever budget
 * is left, in page and finding order; findings past that point are listed
 * without quotes. Further over budget it drops notes, then topics, then
 * findings, then summaries, then lists "…and N more".
 * @param {PageScanResult[]} results
 * @param {{maxChars: number}} options
 * @returns {string}
 */
export function formatScanResults(results, { maxChars }) {
  const budget = Math.max(1, Math.floor(Number(maxChars) || 0));
  const list = Array.isArray(results) ? results : [];
  if (!list.length) return clip('No pages were scanned.', budget);
  const relevant = [
    ...list.filter((r) => r.relevance === 'high'),
    ...list.filter((r) => r.relevance === 'low'),
  ];
  const noneResults = list.filter((r) => r.relevance === 'none');
  // A "none" verdict on a partly scanned page says nothing about the unread rest.
  const partialNone = noneResults.filter((r) => coverageNote(r));
  const none = noneResults.filter((r) => !coverageNote(r)).map((r) => r.page);
  const failed = list.filter((r) => !Object.hasOwn(RELEVANCE_RANK, r.relevance));
  const noneLine = none.length ? `Nothing relevant found on pages: ${compactNumbers(none)}.` : '';
  const formatPartialNone = (level) => {
    if (!partialNone.length) return '';
    if (level >= 3) {
      return `Nothing relevant in the scanned part of pages (only partly scanned; the rest may still be relevant): ${compactNumbers(partialNone.map((r) => r.page))}.`;
    }
    return [
      'Nothing relevant in the scanned part (the rest of these pages was not checked):',
      ...partialNone.map(
        (r) =>
          `- page ${r.page} "${clip(r.title || r.url || 'Untitled page', TITLE_CHARS)}"${coverageNote(r)}`,
      ),
    ].join('\n');
  };

  const render = (level, shown = relevant.length, quoteChars = 0) => {
    const quota = level === 0 && quoteChars > 0 ? { left: quoteChars, cut: false } : null;
    const parts = relevant.slice(0, shown).map((r) => formatRelevant(r, level, quota));
    if (quota?.cut) parts.push(QUOTES_CUT_NOTE);
    if (!relevant.length) parts.push('No page was found relevant to the question.');
    if (shown < relevant.length) {
      const rest = relevant.slice(shown).map((r) => r.page);
      parts.push(`…and ${rest.length} more relevant pages (${compactNumbers(rest)}).`);
    }
    if (noneLine) parts.push(noneLine);
    const partial = formatPartialNone(level);
    if (partial) parts.push(partial);
    const failures = formatFailures(failed, level);
    if (failures) parts.push(failures);
    return parts.join('\n');
  };

  if (render(0).length <= budget) {
    // Spend the rest of the budget on quotes: the largest quota that still fits.
    const wanted = fullQuoteChars(relevant);
    if (!wanted) return render(0);
    if (render(0, relevant.length, wanted).length <= budget) {
      return render(0, relevant.length, wanted);
    }
    let low = 0;
    let high = wanted;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (render(0, relevant.length, middle).length <= budget) low = middle;
      else high = middle - 1;
    }
    return render(0, relevant.length, low);
  }
  for (let level = 1; level < DETAIL_LEVELS; level++) {
    const text = render(level);
    if (text.length <= budget) return text;
  }
  for (let shown = relevant.length - 1; shown >= 0; shown--) {
    const text = render(DETAIL_LEVELS - 1, shown);
    if (text.length <= budget) return text;
  }
  const text = render(DETAIL_LEVELS - 1, 0);
  return `${text.slice(0, budget - 1)}…`;
}
