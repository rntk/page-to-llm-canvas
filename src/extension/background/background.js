import {
  readRecord,
  writeRecord,
  updateRecord,
  listRecords,
  deleteRecord,
  deleteAll,
  findRecordByUrl,
  migrateIndexMeta,
  reconcileRecordStorage,
} from '../../../worker/storage/storage.js';
import {
  listChats,
  readChat,
  appendChatTurn,
  deleteChatHistory,
  reconcileChatStorage,
} from '../../../worker/storage/chatStorage.js';
import { runPipeline } from '../../../worker/pipeline/orchestrator.js';
import { callLLMDirect } from '../../../worker/llm/llm.js';
import { clearLlmMetrics, recordLlmMetric } from '../../../worker/metrics/llm.js';
import { clearChatToolMetrics, recordChatToolMetric } from '../../../worker/metrics/chatTool.js';
import { clearParserMetrics } from '../../../worker/metrics/parser.js';
import { clearAllExtensionData, getStorageOverview } from '../../../worker/storage/dataManagement.js';
import { getStoredSummariesDisabled } from '../../../worker/settings/summary.js';
import {
  getProvidersState,
  sanitizeProvider,
  sanitizeProvidersState,
  saveProvider,
  deleteProvider,
  setActiveProvider,
} from '../../../worker/llm/providers.js';
import {
  refreshActionProgressIcon,
  scheduleActionProgressIconRefresh,
} from '../../../worker/actionIcon.js';
import { isInFlightRecord, isInFlightStatus } from '../../../worker/pipeline/pipelineStatus.js';
import { MSG } from '../../shared/runtime/messages.js';

const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
const RECORD_STORAGE_PREFIX = 'pagetollm:rec:';
/**
 * One turn can fan out into several provider requests. This registry is
 * deliberately best-effort: MV3 worker termination drops both these
 * controllers and the fetches they own, so there is no resumable request state
 * to persist for a later cancel message.
 */
const activeChatRequests = new Map();
const activeChatCompletionJobs = new Set();

function registerChatRequest(turnId, controller) {
  if (!turnId) return;
  const controllers = activeChatRequests.get(turnId) || new Set();
  controllers.add(controller);
  activeChatRequests.set(turnId, controllers);
}

function unregisterChatRequest(turnId, controller) {
  if (!turnId) return;
  const controllers = activeChatRequests.get(turnId);
  if (!controllers) return;
  controllers.delete(controller);
  if (controllers.size === 0) activeChatRequests.delete(turnId);
}

function isSafeChatId(chatId) {
  return typeof chatId === 'string' && !!chatId && !chatId.includes(':');
}

function isExtensionPageSender(sender) {
  const extensionRoot =
    typeof chrome.runtime.getURL === 'function' ? chrome.runtime.getURL('') : '';
  return !!sender?.url && !!extensionRoot && sender.url.startsWith(extensionRoot);
}

// Alarm name used to keep the service worker alive while pipelines are running.
const KEEPALIVE_ALARM = 'pipeline-keepalive';
// Chrome MV3 enforces a minimum of 30 s (0.5 min) for alarm periods.
const KEEPALIVE_PERIOD_MINUTES = 0.5;

function isImportableRecord(record) {
  return (
    !!record &&
    typeof record === 'object' &&
    typeof record.key === 'string' &&
    !!record.key.trim() &&
    (typeof record.html === 'string' ||
      typeof record.text === 'string' ||
      Array.isArray(record.sentences) ||
      Array.isArray(record.topics) ||
      !!record.topic_summaries)
  );
}

/**
 * Returns a copy of the topic-summaries map with every in-flight error marker
 * (the `error` flag and its reason fields) removed, so the failed leaves are
 * reused as legit empty summaries on the next resume instead of being re-queried.
 *
 * @param {Record<string, object>} topicSummaries
 * @returns {Record<string, object>}
 */
export function clearSummaryErrorFlags(topicSummaries) {
  const src = topicSummaries && typeof topicSummaries === 'object' ? topicSummaries : {};
  const out = {};
  for (const [name, s] of Object.entries(src)) {
    if (s && typeof s === 'object') {
      // eslint-disable-next-line no-unused-vars
      const { error, error_kind, error_message, error_detail, ...rest } = s;
      out[name] = rest;
    } else {
      out[name] = s;
    }
  }
  return out;
}

function scheduleKeepAlive() {
  chrome.alarms.get(KEEPALIVE_ALARM, (existing) => {
    if (!existing) {
      chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_PERIOD_MINUTES });
    }
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  // Resume any in-flight records that lost their SW context (e.g. after SW termination).
  listRecords().then((items) => {
    const inFlight = items.filter(isInFlightRecord);
    if (inFlight.length === 0) {
      chrome.alarms.clear(KEEPALIVE_ALARM);
      return;
    }
    for (const rec of inFlight) {
      startPipeline(rec.key).catch((err) => {
        console.error('PageToLLM Canvas keepalive resume failed for', rec.key, err);
      });
    }
  });
});

try {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (Object.keys(changes).some((key) => key.startsWith(RECORD_STORAGE_PREFIX))) {
      scheduleActionProgressIconRefresh();
    }
  });
} catch (_) {
  /* noop */
}

/**
 * In-memory job registry to prevent duplicate pipeline runs while the
 * service worker is alive. Keyed by record key; value is the run promise.
 * @type {Map<string, {promise: Promise<void>, controller: AbortController, pipelineRunId?: string}>}
 */
const _jobRegistry = new Map();
const _starting = new Set();

/** Clears the in-memory job registry. Exposed for testing only. */
export function _resetJobRegistry() {
  for (const job of _jobRegistry.values()) {
    job.controller.abort();
  }
  _jobRegistry.clear();
  _starting.clear();
}

function createPipelineRunId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function cancelActivePipeline(key) {
  const job = _jobRegistry.get(key);
  if (!job) return false;
  job.controller.abort();
  _jobRegistry.delete(key);
  // Intentionally do NOT clear the keepalive alarm here: the in-memory registry
  // is not the source of truth for whether work remains. A record can still be
  // in an in-flight status in storage (e.g. an aborted run that left its status
  // untouched). The onAlarm handler is the only place allowed to clear the
  // alarm, and it does so from storage after confirming nothing is in-flight.
  return true;
}

/**
 * @param {object} rec
 * @returns {boolean}
 */
function isStaleRecord(rec) {
  if (!rec) return false;
  if (!isInFlightStatus(rec.status)) return false;
  const age = Date.now() - (rec.updatedAt || 0);
  return age > STALE_THRESHOLD_MS;
}

/**
 * @param {string} s
 * @returns {Promise<string>}
 */
async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  const bytes = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * Starts the pipeline for a key if it is not already running.
 * Resumes stale or orphaned in-flight records (e.g. after a SW restart).
 * If a job is already in the registry but the record is stale (updatedAt older
 * than STALE_THRESHOLD_MS), the hung promise is evicted and the job is restarted.
 *
 * @param {string} key
 * @returns {Promise<void>}
 */
export async function startPipeline(key) {
  if (_starting.has(key)) return;

  _starting.add(key);
  try {
    const rec = await readRecord(key);
    if (!rec) return;

    if (!isInFlightStatus(rec.status)) return;

    // Skip if a healthy (non-stale) job is already in the registry.
    if (_jobRegistry.has(key) && !isStaleRecord(rec)) return;

    // Evict and abort any hung/stale promise before starting fresh.
    cancelActivePipeline(key);

    scheduleKeepAlive();

    const controller = new AbortController();
    const pipelineRunId = rec.pipelineRunId;
    const promise = runPipeline(key, {
      pipelineRunId,
      signal: controller.signal,
    })
      .catch((err) => {
        console.error('PageToLLM Canvas background pipeline failed for', key, err);
      })
      .finally(() => {
        const current = _jobRegistry.get(key);
        if (current?.promise === promise) {
          _jobRegistry.delete(key);
        }
        // Do not clear the keepalive alarm from here. If this run finished by
        // being aborted, the record may still be in an in-flight status in
        // storage; clearing the alarm would orphan it with nothing left to
        // resume it. The onAlarm handler clears the alarm from storage truth.
      });

    _jobRegistry.set(key, { promise, controller, pipelineRunId });
    return promise;
  } finally {
    _starting.delete(key);
  }
}

/**
 * @param {{html?: string, sourceUrl?: string, selectors?: string[]}} submission
 * @returns {Promise<{ok: boolean, key?: string, error?: string}>}
 */
export async function handleSubmit(submission) {
  const { html, sourceUrl, selectors } = submission;
  if (!html) return { ok: false, error: 'missing html' };

  let existing = null;
  if (sourceUrl) {
    existing = await findRecordByUrl(sourceUrl);
  }

  let key;
  if (existing) {
    key = existing.key;
  } else {
    const hex = await sha256Hex(html);
    key = hex.slice(0, 32);
    existing = await readRecord(key);
  }

  if (existing && existing.status === 'done') {
    return { ok: true, key };
  }

  // If a job is already running (or starting) for this key, do not clobber it.
  if (_jobRegistry.has(key) || _starting.has(key)) {
    return { ok: true, key };
  }

  const now = Date.now();
  const pipelineRunId = createPipelineRunId();
  // Whether this run generates summaries is decided here, at kickoff, from the
  // global toggle, and persisted on the record as a run directive. The
  // orchestrator only ever reads the record, so the decision survives mid-run
  // toggle flips and service-worker restarts (see runPipeline).
  const skipSummaries = await getStoredSummariesDisabled();
  const rec = existing || {
    key,
    sourceUrl: sourceUrl || '',
    html,
    text: '',
    status: 'pending',
    error: null,
    progress: { stage: 'queued', done: 0, total: 0 },
    sentences: [],
    topics: [],
    topic_summaries: {},
    topic_summary_index: {},
    processingLog: [],
    selectors: Array.isArray(selectors) ? selectors : [],
    pipelineRunId,
    skipSummaries,
    createdAt: now,
    updatedAt: now,
  };
  if (existing) {
    rec.pipelineRunId = pipelineRunId;
    rec.status = 'pending';
    rec.error = null;
    rec.progress = { stage: 'queued', done: 0, total: 0 };
    rec.updatedAt = now;
    rec.sourceUrl = sourceUrl || rec.sourceUrl;
    rec.html = html;
    rec.processingLog = [];
    rec.skipSummaries = skipSummaries;
    if (Array.isArray(selectors)) rec.selectors = selectors;
  }
  await writeRecord(rec, { bumpContentRevision: !!existing });

  // Start the pipeline in the background; do not await.
  startPipeline(key).catch((err) => {
    console.error('PageToLLM Canvas background startPipeline failed:', err);
  });

  return { ok: true, key };
}

/**
 * Declarative handler registry.
 *
 * Each entry has:
 *   requiresExtensionPage {boolean}  – when true, sender must be an extension page
 *   validate(msg) {function}         – returns an error string or null
 *   handle(msg, sender) {function}   – async, returns the response fields object
 *
 * @type {Record<string, {
 *   requiresExtensionPage: boolean,
 *   validate: (msg: object) => string | null,
 *   handle: (msg: object, sender: object) => Promise<object>
 * }>}
 */
export const MESSAGE_HANDLERS = {
  [MSG.submit]: {
    requiresExtensionPage: false,
    validate: () => null,
    async handle(msg) {
      return handleSubmit(msg);
    },
  },

  [MSG.ensurePipeline]: {
    requiresExtensionPage: false,
    validate(msg) {
      return msg.key ? null : 'missing key';
    },
    async handle(msg) {
      await startPipeline(msg.key);
      return { ok: true };
    },
  },

  [MSG.retryRecord]: {
    requiresExtensionPage: false,
    validate(msg) {
      return msg.key ? null : 'missing key';
    },
    async handle(msg) {
      cancelActivePipeline(msg.key);
      const updated = await updateRecord(msg.key, {
        pipelineRunId: createPipelineRunId(),
        status: 'pending',
        error: null,
        progress: { stage: 'queued', done: 0, total: 0 },
        skipSummaries: await getStoredSummariesDisabled(),
      });
      if (!updated) {
        return { ok: false, error: 'record not found' };
      }
      startPipeline(msg.key).catch((err) => {
        console.error('PageToLLM Canvas retryRecord startPipeline failed:', err);
      });
      return { ok: true };
    },
  },

  [MSG.reprocessRecord]: {
    requiresExtensionPage: false,
    validate(msg) {
      return msg.key ? null : 'missing key';
    },
    async handle(msg) {
      const rec = await readRecord(msg.key);
      if (!rec) {
        return { ok: false, error: 'record not found' };
      }
      cancelActivePipeline(msg.key);
      await updateRecord(
        msg.key,
        {
          pipelineRunId: createPipelineRunId(),
          status: 'pending',
          error: null,
          progress: { stage: 'queued', done: 0, total: 0 },
          topics: [],
          topic_summaries: {},
          topic_summary_index: {},
          sentences: [],
          text: '',
          processingLog: [],
          skipSummaries: await getStoredSummariesDisabled(),
        },
        { bumpContentRevision: true },
      );
      startPipeline(msg.key).catch((err) => {
        console.error('PageToLLM Canvas reprocessRecord startPipeline failed:', err);
      });
      return { ok: true };
    },
  },

  // Generates (or completes) summaries for an already-processed record without
  // redoing the clean/split/topic-ranges stages. Not a new pipeline mode: the
  // record is put back into the 'summarizing' stage with an explicit
  // "summaries on" run directive, and the orchestrator's existing resume path
  // reuses the stored topics/sentences, keeps summaries that already succeeded,
  // and only queries the LLM for the ones still missing or failed.
  [MSG.generateRecordSummaries]: {
    requiresExtensionPage: false,
    validate(msg) {
      return msg.key ? null : 'missing key';
    },
    async handle(msg) {
      const rec = await readRecord(msg.key);
      if (!rec) {
        return { ok: false, error: 'record not found' };
      }
      // The resume path needs the topics and their source sentences; without
      // them there is nothing to summarize against — that's a full reprocess.
      if (
        !Array.isArray(rec.topics) ||
        rec.topics.length === 0 ||
        !Array.isArray(rec.sentences) ||
        rec.sentences.length === 0
      ) {
        return { ok: false, error: 'record has no topics yet — reprocess it instead' };
      }
      cancelActivePipeline(msg.key);
      await updateRecord(msg.key, {
        pipelineRunId: createPipelineRunId(),
        status: 'summarizing',
        error: null,
        // Explicit intent: this run generates summaries even while the global
        // "disable summaries" toggle is on.
        skipSummaries: false,
        summaryErrors: [],
        forceFinalize: false,
        progress: { stage: 'summarizing_topics', done: 0, total: rec.topics.length },
      });
      startPipeline(msg.key).catch((err) => {
        console.error('PageToLLM Canvas generateRecordSummaries startPipeline failed:', err);
      });
      return { ok: true };
    },
  },

  [MSG.cancelRecordProcessing]: {
    requiresExtensionPage: false,
    validate(msg) {
      return msg.key ? null : 'missing key';
    },
    async handle(msg) {
      const rec = await readRecord(msg.key);
      if (!rec) {
        return { ok: false, error: 'record not found' };
      }
      cancelActivePipeline(msg.key);
      if (!isInFlightStatus(rec.status)) {
        return { ok: true, stale: true };
      }
      await updateRecord(msg.key, {
        pipelineRunId: createPipelineRunId(),
        status: 'cancelled',
        error: 'Processing stopped.',
        progress: { stage: 'cancelled', done: 0, total: 0 },
      });
      return { ok: true };
    },
  },

  [MSG.resolveSummaryErrors]: {
    requiresExtensionPage: false,
    validate(msg) {
      if (!msg.key) return 'missing key';
      if (msg.action !== 'retry' && msg.action !== 'skip') return 'invalid action';
      return null;
    },
    async handle(msg) {
      const rec = await readRecord(msg.key);
      if (!rec) {
        return { ok: false, error: 'record not found' };
      }
      // Only a parked record can be resolved; ignore stale/double clicks.
      if (rec.status !== 'needs_attention') {
        return { ok: true, stale: true };
      }

      cancelActivePipeline(msg.key);
      const patch = {
        pipelineRunId: createPipelineRunId(),
        status: 'summarizing',
        error: null,
        summaryErrors: [],
        forceFinalize: msg.action === 'skip',
        // Reset the parked progress stage so the resuming UI shows summarizing,
        // not the transient 'needs_attention' stage, before the worker's first write.
        progress: { stage: 'summarizing_topics', done: 0, total: 0 },
      };
      if (msg.action === 'skip') {
        // Accept the empty summaries: drop the in-flight error flags so the
        // resumed run reuses the failed leaves as-is (no re-query), and let
        // forceFinalize push the merge/finalize through even if it also degrades.
        patch.topic_summaries = clearSummaryErrorFlags(rec.topic_summaries);
      }
      await updateRecord(msg.key, patch);
      startPipeline(msg.key).catch((err) => {
        console.error('PageToLLM Canvas resolveSummaryErrors startPipeline failed:', err);
      });
      return { ok: true };
    },
  },

  [MSG.getRecord]: {
    requiresExtensionPage: false,
    validate: () => null,
    async handle(msg) {
      const rec = await readRecord(msg.key);
      if (rec) return { ok: true, record: rec };
      return { ok: false };
    },
  },

  [MSG.listRecords]: {
    requiresExtensionPage: false,
    validate: () => null,
    async handle() {
      const items = await listRecords();
      return { ok: true, items };
    },
  },

  [MSG.importRecords]: {
    requiresExtensionPage: true,
    validate: () => null,
    async handle(msg) {
      const records = Array.isArray(msg.records) ? msg.records : [];
      if (records.length === 0) return { ok: false, error: 'no records to import' };

      let count = 0;
      const recordsByKey = new Map();
      for (const record of records) {
        if (!isImportableRecord(record)) continue;
        recordsByKey.set(record.key.trim(), record);
      }

      for (const record of recordsByKey.values()) {
        const key = record.key.trim();
        const status = isInFlightStatus(record.status) ? 'done' : record.status || 'done';
        cancelActivePipeline(key);
        await writeRecord(
          {
            ...record,
            key,
            pipelineRunId: createPipelineRunId(),
            status,
            error: status === 'done' ? null : record.error || null,
            progress: {
              ...(record.progress && typeof record.progress === 'object' ? record.progress : {}),
              stage: 'imported',
              done: 1,
              total: 1,
            },
          },
          { bumpContentRevision: true },
        );
        count += 1;
      }

      if (count === 0) return { ok: false, error: 'no valid records to import' };
      return { ok: true, count };
    },
  },

  [MSG.deleteRecord]: {
    requiresExtensionPage: false,
    validate: () => null,
    async handle(msg) {
      cancelActivePipeline(msg.key);
      await deleteRecord(msg.key);
      return { ok: true };
    },
  },

  [MSG.deleteAll]: {
    requiresExtensionPage: false,
    validate: () => null,
    async handle() {
      for (const key of Array.from(_jobRegistry.keys())) {
        cancelActivePipeline(key);
      }
      await deleteAll();
      return { ok: true };
    },
  },

  [MSG.getStorageOverview]: {
    requiresExtensionPage: true,
    validate: () => null,
    async handle() {
      return { ok: true, overview: await getStorageOverview() };
    },
  },

  [MSG.deleteAllExtensionData]: {
    requiresExtensionPage: true,
    validate: () => null,
    async handle() {
      const pipelineJobs = Array.from(_jobRegistry.values(), (job) => job.promise);
      for (const key of Array.from(_jobRegistry.keys())) cancelActivePipeline(key);
      for (const controllers of activeChatRequests.values()) {
        for (const controller of controllers) controller.abort();
      }
      activeChatRequests.clear();

      // Let cancelled work reach its terminal metric/log writes, then drain
      // each metrics queue before the authoritative storage clear. This keeps
      // an old request from restoring data immediately after reset returns.
      await Promise.allSettled([...pipelineJobs, ...activeChatCompletionJobs]);
      await Promise.all([clearLlmMetrics(), clearParserMetrics(), clearChatToolMetrics()]);
      await clearAllExtensionData();
      return { ok: true };
    },
  },

  [MSG.llmChatCompletion]: {
    requiresExtensionPage: false,
    validate: () => null,
    async handle(msg) {
      const completionJob = (async () => {
        const {
          prompt = '',
          messages,
          tools,
          toolChoice,
          parallelToolCalls,
          temperature = 0.8,
          model,
          taskType,
          chatTurnId,
        } = msg;
        if (!prompt && (!Array.isArray(messages) || messages.length === 0)) {
          return { ok: false, error: 'missing prompt or messages' };
        }
        // Record duration/token/cache metrics for chat calls. The orchestrator path
        // is wrapped separately (wrapCallLLMWithRetry); callLLMDirect itself stays
        // unmetered so pipeline calls are not double-counted here.
        const startedAt = Date.now();
        let sample;
        const controller = chatTurnId ? new AbortController() : null;
        registerChatRequest(chatTurnId, controller);
        let result;
        try {
          result = await callLLMDirect({
            prompt,
            messages,
            tools,
            toolChoice,
            parallelToolCalls,
            temperature,
            model,
            signal: controller?.signal,
            metricsCollector: (collected) => {
              if (collected && typeof collected === 'object') sample = collected;
            },
          });
        } finally {
          unregisterChatRequest(chatTurnId, controller);
        }
        // Await (unlike the orchestrator's fire-and-forget): this handler is
        // terminal, so a void'd write could be dropped when the service worker
        // suspends right after the response is sent. recordLlmMetric swallows its
        // own errors and returns void, so awaiting can't fail the response.
        await recordLlmMetric({
          durationMs: Date.now() - startedAt,
          ok: result.ok,
          taskType,
          error: result.ok ? undefined : result.error,
          ...sample,
        });
        return result;
      })();
      activeChatCompletionJobs.add(completionJob);
      try {
        return await completionJob;
      } finally {
        activeChatCompletionJobs.delete(completionJob);
      }
    },
  },

  [MSG.cancelChatTurn]: {
    requiresExtensionPage: false,
    validate(msg) {
      return typeof msg.turnId === 'string' && msg.turnId ? null : 'missing turnId';
    },
    async handle(msg) {
      const controllers = activeChatRequests.get(msg.turnId);
      if (controllers) {
        for (const controller of controllers) controller.abort();
        activeChatRequests.delete(msg.turnId);
      }
      return { ok: true };
    },
  },

  // Records the outcome of one article-chat highlight_span tool call. The
  // classification happens page-side (in articleChat.js) but chat mounts in
  // content scripts too, so recording is centralized here in the worker.
  // Terminal handler: await the write so it is not dropped on SW suspension.
  [MSG.recordChatToolMetric]: {
    requiresExtensionPage: false,
    validate: () => null,
    async handle(msg) {
      await recordChatToolMetric({ outcome: msg.outcome, error: msg.error });
      return { ok: true };
    },
  },

  // Clearing runs in the worker (not the options realm) so it serializes on the
  // same writeChain as recordChatToolMetric — otherwise an in-flight worker
  // record could restore the pre-clear aggregate after an options-side clear.
  [MSG.clearChatToolMetrics]: {
    requiresExtensionPage: false,
    validate: () => null,
    async handle() {
      await clearChatToolMetrics();
      return { ok: true };
    },
  },

  [MSG.listChats]: {
    requiresExtensionPage: false,
    validate(msg) {
      return msg.key ? null : 'missing key';
    },
    async handle(msg) {
      return { ok: true, chats: await listChats(msg.key) };
    },
  },

  [MSG.getChat]: {
    requiresExtensionPage: false,
    validate(msg) {
      if (!msg.key) return 'missing key';
      if (!msg.chatId) return 'missing chatId';
      return isSafeChatId(msg.chatId) ? null : 'invalid chatId';
    },
    async handle(msg) {
      const chat = await readChat(msg.key, msg.chatId);
      return chat ? { ok: true, chat } : { ok: false, error: 'chat not found' };
    },
  },

  // Persists a whole LLM turn (messages + events) as one atomic write; a falsy
  // chatId creates the chat inline so a failed first turn leaves no orphan chat.
  [MSG.appendChatTurn]: {
    requiresExtensionPage: false,
    validate(msg) {
      if (!msg.key) return 'missing key';
      if (msg.chatId && !isSafeChatId(msg.chatId)) return 'invalid chatId';
      if (!msg.turn || typeof msg.turn !== 'object') return 'missing turn';
      const hasMessages = Array.isArray(msg.turn.messages) && msg.turn.messages.length > 0;
      const hasEvents = Array.isArray(msg.turn.events) && msg.turn.events.length > 0;
      return hasMessages || hasEvents ? null : 'empty turn';
    },
    async handle(msg) {
      const { chat, messages, events } = await appendChatTurn(msg.key, msg.chatId, msg.turn);
      return { ok: true, chat, messages, events };
    },
  },

  [MSG.deleteChat]: {
    requiresExtensionPage: false,
    validate(msg) {
      if (!msg.key) return 'missing key';
      if (!msg.chatId) return 'missing chatId';
      return isSafeChatId(msg.chatId) ? null : 'invalid chatId';
    },
    async handle(msg) {
      await deleteChatHistory(msg.key, msg.chatId);
      return { ok: true };
    },
  },

  [MSG.listProviders]: {
    requiresExtensionPage: true,
    validate: () => null,
    async handle() {
      const state = await getProvidersState();
      return { ok: true, ...sanitizeProvidersState(state) };
    },
  },

  [MSG.saveProvider]: {
    requiresExtensionPage: true,
    validate: () => null,
    async handle(msg) {
      const provider = await saveProvider(msg.provider);
      const state = await getProvidersState();
      return { ok: true, provider: sanitizeProvider(provider), ...sanitizeProvidersState(state) };
    },
  },

  [MSG.deleteProvider]: {
    requiresExtensionPage: true,
    validate(msg) {
      return msg.id ? null : 'missing id';
    },
    async handle(msg) {
      const state = await deleteProvider(msg.id);
      return { ok: true, ...sanitizeProvidersState(state) };
    },
  },

  [MSG.setActiveProvider]: {
    requiresExtensionPage: true,
    validate(msg) {
      return msg.id ? null : 'missing id';
    },
    async handle(msg) {
      const state = await setActiveProvider(msg.id);
      return { ok: true, ...sanitizeProvidersState(state) };
    },
  },
};

/**
 * Pure dispatch function. Owns: unknown-type handling, extension-page sender
 * gating, per-handler validation, and try/catch wrapping. Always resolves.
 *
 * Precondition: msg is non-null and has a non-empty `type` field.
 * (The `no type` short-circuit is the listener's responsibility so it can
 * return `false` synchronously in that case.)
 *
 * @param {object} msg
 * @param {object} sender
 * @param {typeof MESSAGE_HANDLERS} [handlers]
 * @returns {Promise<object>}
 */
export async function dispatchMessage(msg, sender, handlers = MESSAGE_HANDLERS) {
  const entry = handlers[msg.type];
  if (!entry) {
    return { ok: false, error: 'unknown type: ' + msg.type };
  }

  if (entry.requiresExtensionPage && !isExtensionPageSender(sender)) {
    return { ok: false, error: 'provider settings are only available to extension pages' };
  }

  const validationError = entry.validate(msg);
  if (validationError) {
    return { ok: false, error: validationError };
  }

  try {
    return await entry.handle(msg, sender);
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) {
    sendResponse({ ok: false, error: 'no type' });
    return false;
  }

  dispatchMessage(msg, sender).then(sendResponse);

  return true;
});

/**
 * Reconciles storage against the in-memory job registry: any record still in an
 * in-flight status is (re)started and the keepalive alarm is (re)armed. The
 * job registry does not survive service-worker termination, and the keepalive
 * alarm can be lost across a browser restart or extension update, so this scan
 * is what repairs records that would otherwise be orphaned mid-pipeline (see
 * onStartup/onInstalled below). startPipeline dedupes against the registry, so
 * calling this when jobs are already healthy is a no-op.
 */
async function resumeInFlightRecords() {
  let items;
  try {
    items = await listRecords();
  } catch (err) {
    console.warn('PageToLLM Canvas resume scan failed:', err);
    return;
  }
  const inFlight = (Array.isArray(items) ? items : []).filter(isInFlightRecord);
  if (inFlight.length === 0) return;
  scheduleKeepAlive();
  for (const rec of inFlight) {
    startPipeline(rec.key).catch((err) => {
      console.error('PageToLLM Canvas resume failed for', rec.key, err);
    });
  }
}

// Resume orphaned in-flight records when the browser starts or the extension is
// installed/updated — the two events that can drop the keepalive alarm the
// running-pipeline resume otherwise depends on. Guarded because not every
// runtime (or test harness) exposes these events.
if (chrome.runtime?.onStartup?.addListener) {
  chrome.runtime.onStartup.addListener(() => {
    void resumeInFlightRecords();
  });
}
if (chrome.runtime?.onInstalled?.addListener) {
  chrome.runtime.onInstalled.addListener(() => {
    void resumeInFlightRecords();
  });
}

// Repair interrupted page/index writes before reconciling their dependent
// chats. Both routines are idempotent and share the global mutation queue with
// normal writes, so startup races cannot resurrect deleted data.
void (async () => {
  try {
    await reconcileRecordStorage();
    await migrateIndexMeta();
    await reconcileChatStorage();
  } catch (err) {
    console.warn('PageToLLM Canvas: storage reconciliation failed:', err);
  }
})();

void refreshActionProgressIcon();
