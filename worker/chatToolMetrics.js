// Privacy-safe article-chat tool-call metrics. Tracks the outcome of every
// highlight_span tool call the model makes (accepted, skipped, or rejected as
// wrong/malformed) so bad tool calls are visible in diagnostics. Never stores
// prompts, responses, article text, URLs, record keys, or highlight labels —
// only an outcome code, a timestamp, and the short model-facing error string
// (which contains line numbers at most, e.g. "line range must be between 1 and 42").
//
// TO REMOVE ENTIRELY:
//   1. Delete this file (and chatToolMetrics.test.js)
//   2. In background.js: remove the recordChatToolMetric/clearChatToolMetrics
//      imports + the MSG.recordChatToolMetric / MSG.clearChatToolMetrics handlers
//   3. In messages.js: remove the recordChatToolMetric + clearChatToolMetrics types
//   4. In src/chat/articleChat.js: remove the recordToolMetric plumbing
//   5. In OptionsApp.jsx: remove ChatToolMetricsSection + its import + render

export const CHAT_TOOL_METRICS_KEY = 'pagetollm-chat-tool-metrics';
export const CHAT_TOOL_METRICS_MAX_RECENT = 60;

/** Stable outcome codes for one highlight_span tool call. */
export const CHAT_TOOL_OUTCOMES = Object.freeze({
  HIGHLIGHTED: 'highlighted',
  OVERLAP_SKIPPED: 'overlap_skipped',
  UNKNOWN_TOOL: 'unknown_tool',
  INVALID_ARGUMENTS: 'invalid_arguments',
  OUT_OF_RANGE: 'out_of_range',
  OUT_OF_CHUNK: 'out_of_chunk',
  PAINT_FAILED: 'paint_failed',
});

/** Human-readable labels for the diagnostics UI. */
export const CHAT_TOOL_OUTCOME_LABELS = Object.freeze({
  [CHAT_TOOL_OUTCOMES.HIGHLIGHTED]: 'Highlighted',
  [CHAT_TOOL_OUTCOMES.OVERLAP_SKIPPED]: 'Skipped (overlap)',
  [CHAT_TOOL_OUTCOMES.UNKNOWN_TOOL]: 'Unknown tool',
  [CHAT_TOOL_OUTCOMES.INVALID_ARGUMENTS]: 'Invalid arguments',
  [CHAT_TOOL_OUTCOMES.OUT_OF_RANGE]: 'Out of range',
  [CHAT_TOOL_OUTCOMES.OUT_OF_CHUNK]: 'Outside chunk',
  [CHAT_TOOL_OUTCOMES.PAINT_FAILED]: 'Highlight paint failed',
});

const OUTCOME_KEYS = Object.values(CHAT_TOOL_OUTCOMES);

// A wrong/malformed tool call the model must correct. `overlap_skipped` and
// `paint_failed` are not model errors — the range was valid; the passage was
// already highlighted, or a best-effort live paint failed after the range was
// already committed for persistence.
const ERROR_OUTCOMES = new Set([
  CHAT_TOOL_OUTCOMES.UNKNOWN_TOOL,
  CHAT_TOOL_OUTCOMES.INVALID_ARGUMENTS,
  CHAT_TOOL_OUTCOMES.OUT_OF_RANGE,
  CHAT_TOOL_OUTCOMES.OUT_OF_CHUNK,
]);

/**
 * @param {unknown} outcome
 * @returns {string | null} the outcome if recognized, otherwise null
 */
export function normalizeOutcome(outcome) {
  return typeof outcome === 'string' && OUTCOME_KEYS.includes(outcome) ? outcome : null;
}

/** @param {unknown} outcome */
export function isErrorOutcome(outcome) {
  return ERROR_OUTCOMES.has(normalizeOutcome(outcome));
}

function nonNegative(value) {
  return Math.max(0, Number(value) || 0);
}

export function emptyChatToolMetrics() {
  return {
    totalCount: 0,
    okCount: 0,
    errorCount: 0,
    byOutcome: Object.fromEntries(OUTCOME_KEYS.map((key) => [key, 0])),
    recent: [],
  };
}

export function normalizeChatToolMetrics(value) {
  const empty = emptyChatToolMetrics();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return empty;
  const byOutcome = {};
  for (const key of OUTCOME_KEYS) byOutcome[key] = nonNegative(value.byOutcome?.[key]);
  const recent = Array.isArray(value.recent)
    ? value.recent
        .map((entry) => {
          const outcome = normalizeOutcome(entry?.outcome);
          if (!outcome) return null;
          return {
            at: nonNegative(entry?.at),
            outcome,
            error: typeof entry?.error === 'string' ? entry.error.slice(0, 160) : '',
          };
        })
        .filter(Boolean)
        .slice(0, CHAT_TOOL_METRICS_MAX_RECENT)
    : [];
  return {
    totalCount: nonNegative(value.totalCount),
    okCount: nonNegative(value.okCount),
    errorCount: nonNegative(value.errorCount),
    byOutcome,
    recent,
  };
}

let writeChain = Promise.resolve();

function readRaw() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(CHAT_TOOL_METRICS_KEY, (items) =>
        resolve(normalizeChatToolMetrics(items?.[CHAT_TOOL_METRICS_KEY])),
      );
    } catch (_) {
      resolve(emptyChatToolMetrics());
    }
  });
}

export async function getChatToolMetrics() {
  if (typeof chrome === 'undefined' || !chrome?.storage?.local) return emptyChatToolMetrics();
  return readRaw();
}

/**
 * @param {{ outcome?: string, error?: string }} [sample]
 * @returns {Promise<void>}
 */
export function recordChatToolMetric(sample = {}) {
  writeChain = writeChain
    .then(async () => {
      if (typeof chrome === 'undefined' || !chrome?.storage?.local) return;
      const outcome = normalizeOutcome(sample.outcome);
      if (!outcome) return; // Drop unrecognized outcomes rather than corrupt the store.
      const metrics = await readRaw();
      const entry = {
        at: Date.now(),
        outcome,
        error: typeof sample.error === 'string' ? sample.error.slice(0, 160) : '',
      };
      metrics.totalCount++;
      if (isErrorOutcome(outcome)) metrics.errorCount++;
      else metrics.okCount++;
      metrics.byOutcome[outcome] = (metrics.byOutcome[outcome] || 0) + 1;
      metrics.recent.unshift(entry);
      metrics.recent = metrics.recent.slice(0, CHAT_TOOL_METRICS_MAX_RECENT);
      await new Promise((resolve) =>
        chrome.storage.local.set({ [CHAT_TOOL_METRICS_KEY]: metrics }, resolve),
      );
    })
    .catch((error) => console.warn('PageToLLM Canvas chat tool metrics record failed:', error));
  return writeChain;
}

export function clearChatToolMetrics() {
  writeChain = writeChain.then(
    () =>
      new Promise((resolve) => {
        try {
          chrome.storage.local.set({ [CHAT_TOOL_METRICS_KEY]: emptyChatToolMetrics() }, resolve);
        } catch (_) {
          resolve();
        }
      }),
  );
  return writeChain;
}
