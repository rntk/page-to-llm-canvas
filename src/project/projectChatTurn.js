// Turn runner for the project chat. Wraps `runArticleChatTurn` (or a compatible runner) with the
// project's page tools and an overview. Each turn first scans every page against the question
// (earlier questions give follow-up context) and puts the results, with relevant page lines quoted,
// in the overview. The model can still call `ask_pages` for a sub-question and `ask_page_agent`
// to have a helper model work through one page. Pure: the page reader, runtime transport and
// wrapped runner are injected.

import { ARTICLE_CHAT_CHUNK_MAX_CHARS } from '../chat/articleChunking.js';
import { articleChatBudgets, runArticleChatTurn } from '../chat/articleChat.js';
import { abortReason, createTurnId, throwIfAborted } from '../chat/turnCancellation.js';
import {
  PAGE_SCAN_MODES,
  createDecisionPageJudge,
  createLlmPageJudge,
  formatScanResults,
  scanProjectPages,
} from '../core/projects/projectPageScan.js';
import { createPageAgentTool } from '../core/projects/projectPageAgent.js';
import {
  buildProjectPagesOverview,
  createProjectHighlightTool,
  createProjectPageTools,
} from '../core/projects/projectPageTools.js';
import { MSG } from '../shared/runtime/messages.js';

/** Phase name of the progress reported while pages are being scanned. */
export const SCAN_PHASE = 'scan';

// runArticleChatTurn caps a project preamble at half its chunk budget (the rest is for tool results).
// The overview is sized from the chunk budget minus the question, leaving room for the truncation marker.
const OVERVIEW_SHARE = 0.5;
const TRUNCATION_MARKER_CHARS = 24;
const MIN_OVERVIEW_CHARS = 600;
// Scan text gets most of the overview; the page list, tree overview and usage guidance share the rest.
const SCAN_SHARE = 0.7;
const TREE_SHARE = 0.25;
// Earlier user questions handed to the scan judge to resolve follow-ups.
const MAX_EARLIER_QUESTIONS = 3;
const EARLIER_QUESTION_CHARS = 300;
// The merged-tree overview is capped like the tree module's own default.
const TREE_OVERVIEW_MAX_CHARS = 6000;
const MIN_SCAN_CHUNK_CHARS = 200;

const isAbort = (error, signal) => !!signal?.aborted || error?.name === 'AbortError';

/**
 * Character budgets for one turn, derived from the chat limits and question.
 * @param {number|undefined} maxChunkChars
 * @param {string} question
 * @returns {{overviewChars: number, scanChars: number, treeChars: number, scanChunkChars: number}}
 */
export function projectChatBudgets(maxChunkChars, question) {
  const chunkChars =
    Number.isFinite(maxChunkChars) && maxChunkChars > 0
      ? Math.floor(maxChunkChars)
      : ARTICLE_CHAT_CHUNK_MAX_CHARS;
  const available = Math.max(0, chunkChars - String(question || '').length);
  const overviewChars = Math.max(
    MIN_OVERVIEW_CHARS,
    Math.floor(available * OVERVIEW_SHARE) - TRUNCATION_MARKER_CHARS,
  );
  return {
    overviewChars,
    scanChars: Math.floor(overviewChars * SCAN_SHARE),
    treeChars: Math.min(TREE_OVERVIEW_MAX_CHARS, Math.floor(overviewChars * TREE_SHARE)),
    scanChunkChars: Math.max(MIN_SCAN_CHUNK_CHARS, available),
  };
}

/**
 * The chat's latest earlier user questions, oldest first, each clipped.
 * @param {unknown} history Conversation history ({role, content} messages).
 * @returns {string[]}
 */
export function earlierUserQuestions(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((message) => message?.role === 'user' && typeof message.content === 'string')
    .map((message) => message.content.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(-MAX_EARLIER_QUESTIONS)
    .map((text) =>
      text.length <= EARLIER_QUESTION_CHARS
        ? text
        : `${text.slice(0, EARLIER_QUESTION_CHARS - 1).trimEnd()}…`,
    );
}

const normalizeLoaded = (result) => ({
  sentences: Array.isArray(result?.sentences) ? result.sentences.map((s) => String(s ?? '')) : [],
  truncated: result?.truncated === true,
  topics: Array.isArray(result?.topics) ? result.topics : [],
});

/**
 * @param {object} deps
 * @param {Array<{page: number, title: string, url: string}>} deps.pages Readable
 *   project pages, numbered from 1.
 * @param {Array<{title?: string, url?: string, reason?: string}>} [deps.unreadablePages]
 * @param {function(string): Promise<{sentences: string[], truncated?: boolean, topics?: string[]}>} deps.readPage
 *   Reads one page by URL; rejects when it cannot be read.
 * @param {function(): Promise<{ok?: boolean, mode?: string, contextWindowTokens?: number}>} [deps.getScanConfig]
 *   Which scan judge to use; a failure falls back to the completion LLM.
 * @param {function(object): Promise<object>} deps.send Runtime transport; resolves with the raw response.
 * @param {?{tools: object[], buildPreamble: function(object): string}} [deps.treeContext]
 *   Merged-tree tools and overview, when a usable merged tree exists.
 * @param {{eligiblePages?: object[], skippedPages?: object[], stale?: boolean}} [deps.treeOverviewInput]
 * @param {function(object): Promise<object>} [deps.runTurn] The wrapped turn runner.
 * @param {function(?{phase: 'scan', done: number, total: number}): void} [deps.onScanProgress]
 *   Receives scan progress; `null` once the scan has ended (success or failure).
 * @returns {function(object): Promise<object>} A `runTurn(options)` for ArticleChat.
 */
export function createProjectChatTurnRunner({
  pages = [],
  unreadablePages = [],
  readPage,
  getScanConfig,
  send,
  treeContext = null,
  treeOverviewInput = {},
  runTurn = runArticleChatTurn,
  onScanProgress,
}) {
  if (typeof readPage !== 'function') throw new Error('readPage is required');
  if (typeof send !== 'function') throw new Error('send is required');
  const report = (progress) => {
    try {
      onScanProgress?.(progress);
    } catch (_) {
      // Progress display must not fail the turn.
    }
  };

  return async function runProjectChatTurn(options = {}) {
    const runtime = options.runtime || {};
    const signal = runtime.signal;
    const turnId = runtime.turnId || createTurnId();
    const question = String(options.question ?? '');
    const earlierQuestions = earlierUserQuestions(options.article?.history);
    const budgets = projectChatBudgets(options.limits?.maxChunkChars, question);
    throwIfAborted(signal);
    // Reject questions that cannot fit before reading pages or starting scans.
    articleChatBudgets({
      question,
      maxChunkChars: options.limits?.maxChunkChars ?? undefined,
      maxHistoryChars: options.limits?.maxHistoryChars ?? undefined,
    });

    // Per-turn page cache shared by scan and tools. Failed reads are evicted so they can retry.
    const cache = new Map();
    const loadPage = (page) => {
      let entry = cache.get(page.page);
      if (!entry) {
        entry = Promise.resolve()
          .then(() => readPage(page.url))
          .then(normalizeLoaded);
        cache.set(page.page, entry);
        entry.catch(() => {
          if (cache.get(page.page) === entry) cache.delete(page.page);
        });
      }
      return entry;
    };

    // Resolved once per turn, on first use.
    let setup;
    const getSetup = () => {
      setup ??= (async () => {
        let config = null;
        try {
          config = await getScanConfig?.();
        } catch (_) {
          config = null;
        }
        throwIfAborted(signal);
        const decision = config?.ok !== false && config?.mode === PAGE_SCAN_MODES.DECISION;
        if (decision) {
          const contextWindowTokens = Number(config.contextWindowTokens);
          return {
            mode: PAGE_SCAN_MODES.DECISION,
            judge: createDecisionPageJudge({
              decide: async (state, questions) => {
                const response = await send({
                  type: MSG.projectChatDecide,
                  state,
                  questions,
                  chatTurnId: turnId,
                });
                if (!response?.ok) {
                  throw new Error(response?.error || 'The page scan request failed');
                }
                return response;
              },
              ...(contextWindowTokens > 0 ? { contextWindowTokens } : {}),
            }),
          };
        }
        return {
          mode: PAGE_SCAN_MODES.LLM,
          judge: createLlmPageJudge({
            complete: ({ messages, taskType }) =>
              send({ type: MSG.llmChatCompletion, messages, taskType, chatTurnId: turnId }),
            maxChunkChars: budgets.scanChunkChars,
          }),
        };
      })();
      return setup;
    };

    const scan = async ({
      question: scanQuestion,
      pages: subset,
      earlierQuestions: earlier,
      signal: scanSignal,
    }) => {
      const { judge } = await getSetup();
      report({ phase: SCAN_PHASE, done: 0, total: subset.length });
      try {
        return await scanProjectPages({
          pages: subset,
          question: scanQuestion,
          earlierQuestions: earlier,
          loadPage,
          judge,
          signal: scanSignal ?? signal,
          onProgress: ({ done, total }) => report({ phase: SCAN_PHASE, done, total }),
        });
      } finally {
        report(null);
      }
    };

    let scanText = '';
    let scanMode;
    if (pages.length > 0) {
      // The wrapped runner cancels on abort during the turn; this covers aborts during the pre-scan.
      const cancelRequests = () => {
        try {
          Promise.resolve(send({ type: MSG.cancelChatTurn, turnId })).catch(() => {});
        } catch (_) {
          // Best effort.
        }
      };
      signal?.addEventListener('abort', cancelRequests, { once: true });
      try {
        const results = await scan({ question, pages, earlierQuestions, signal });
        ({ mode: scanMode } = await getSetup());
        scanText = formatScanResults(results, { maxChars: budgets.scanChars });
      } catch (error) {
        if (isAbort(error, signal)) throw signal?.aborted ? abortReason(signal) : error;
        // The scan is an aid; on failure the model still has its tools.
        scanText = '';
        scanMode = undefined;
      } finally {
        signal?.removeEventListener('abort', cancelRequests);
      }
    }

    const treeOverview = treeContext
      ? treeContext.buildPreamble({ ...treeOverviewInput, preambleMaxChars: budgets.treeChars })
      : '';
    const preamble = buildProjectPagesOverview({
      pages,
      unreadablePages,
      treeOverview,
      scanText,
      scanMode,
      maxChars: budgets.overviewChars,
    });
    const tools = [
      ...createProjectPageTools({ pages, loadPage, scan }),
      // The page helper's requests carry the turn id so Stop cancels them too.
      createPageAgentTool({
        pages,
        loadPage,
        complete: ({ messages, tools: helperTools, toolChoice, taskType }) =>
          send({
            type: MSG.llmChatCompletion,
            messages,
            tools: helperTools,
            ...(toolChoice ? { toolChoice } : {}),
            taskType,
            chatTurnId: turnId,
          }),
        maxChunkChars: budgets.scanChunkChars,
      }),
      ...(treeContext?.tools || []),
      ...(Array.isArray(options.tools) ? options.tools : []),
    ];

    return runTurn({
      ...options,
      article: { ...options.article, source: { kind: 'project', preamble } },
      tools,
      // Page highlights become chat events that show the cited page lines.
      highlightTool: createProjectHighlightTool({ pages, loadPage }),
      runtime: { ...runtime, turnId },
    });
  };
}
