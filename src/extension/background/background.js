// Browser-only composition root for the MV3 service worker.
//
// This module wires concrete dependencies into the factories that hold the
// worker's behavior (pipelineSupervisor, chatCompletionService, the handler
// groups, dispatch) and installs the Chrome listeners. It deliberately contains
// no business logic of its own: every rule lives in a module that can be
// constructed and tested without a `chrome` global.
//
// The named exports below are the same surface this file has always had. They
// are thin delegates to the instances built here so existing callers and tests
// keep working; new tests should construct the factories directly.
import {
  readRecord,
  writeRecord,
  updateRecord,
  listRecords,
  deleteRecord,
  deleteAll,
  findRecordByUrl,
  reconcileRecordStorage,
} from '../../../worker/storage/storage.js';
import {
  listChats,
  readChat,
  appendChatTurn,
  deleteChatHistory,
  reconcileChatStorage,
} from '../../../worker/storage/chatStorage.js';
import {
  isSummaryCheckpointComplete,
  isSummaryCheckpointRevisionCurrent,
  runPipeline,
  subscribeToLlmConcurrency,
} from '../../../worker/pipeline/orchestrator.js';
import { callLLMDirect } from '../../../worker/llm/llm.js';
import { clearLlmMetrics, recordLlmMetric } from '../../../worker/metrics/llm.js';
import { clearChatToolMetrics, recordChatToolMetric } from '../../../worker/metrics/chatTool.js';
import { clearParserMetrics } from '../../../worker/metrics/parser.js';
import { clearResplitMetrics } from '../../../worker/metrics/resplit.js';
import {
  clearAllExtensionData,
  getStorageOverview,
} from '../../../worker/storage/dataManagement.js';
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
import { createLogger } from '../../shared/runtime/log.js';
import { browserLocalStore } from '../../shared/runtime/localStore.js';
import { createPipelineSupervisor } from './pipelineSupervisor.js';
import { createChatCompletionService } from './chatCompletionService.js';
import { createSubmitRecord } from './submitRecord.js';
import { createDispatcher } from './dispatch.js';
import { installBackgroundRuntime } from './runtime.js';
import { createRecordHandlers } from './handlers/recordHandlers.js';
import { createChatHandlers } from './handlers/chatHandlers.js';
import { createMetricsHandlers } from './handlers/metricsHandlers.js';
import { createProviderHandlers } from './handlers/providerHandlers.js';
import { createDataManagementHandlers } from './handlers/dataManagementHandlers.js';

export { clearSummaryErrorFlags, getAcceptedMergeFailurePaths } from './summaryResolution.js';

const log = createLogger();

const recordRepository = {
  readRecord,
  writeRecord,
  updateRecord,
  listRecords,
  deleteRecord,
  deleteAll,
  findRecordByUrl,
};

const chatRepository = { listChats, readChat, appendChatTurn, deleteChatHistory };

// Chrome namespaces are reached through these accessors rather than captured
// eagerly: `chrome` is a live global that a cold worker (and the test harness)
// can replace between module evaluation and the first call.
const alarms = {
  get: (...args) => chrome.alarms.get(...args),
  create: (...args) => chrome.alarms.create(...args),
  clear: (...args) => chrome.alarms.clear(...args),
};
const runtimeErrors = {
  get lastError() {
    return chrome.runtime.lastError;
  },
};

function isExtensionPageSender(sender) {
  const extensionRoot =
    typeof chrome.runtime.getURL === 'function' ? chrome.runtime.getURL('') : '';
  return !!sender?.url && !!extensionRoot && sender.url.startsWith(extensionRoot);
}

const pipelineSupervisor = createPipelineSupervisor({
  recordRepository,
  runPipeline,
  alarms,
  runtime: runtimeErrors,
  logger: log,
});

const chatService = createChatCompletionService({ callLLMDirect, recordLlmMetric });

const handleSubmitImpl = createSubmitRecord({
  recordRepository,
  getStoredSummariesDisabled,
  pipelineSupervisor,
  logger: log,
});

/**
 * Declarative handler registry, merged from the per-capability groups.
 *
 * Each entry has:
 *   requiresExtensionPage {boolean}  – when true, sender must be an extension page
 *   validate(msg) {function}         – returns an error string or null
 *   handle(msg, sender) {function}   – async, returns the response fields object
 *
 * @type {Record<string, {
 *   requiresExtensionPage: boolean,
 *   validate: function(object): (string|null),
 *   handle: function(object, object): Promise<object>
 * }>}
 */
export const MESSAGE_HANDLERS = {
  ...createRecordHandlers({
    recordRepository,
    handleSubmit: handleSubmitImpl,
    pipelineSupervisor,
    getStoredSummariesDisabled,
    summaryCheckpoint: {
      isComplete: isSummaryCheckpointComplete,
      isRevisionCurrent: isSummaryCheckpointRevisionCurrent,
    },
    logger: log,
  }),
  ...createChatHandlers({ chatRepository, chatService }),
  ...createMetricsHandlers({
    recordChatToolMetric,
    clearChatToolMetrics,
    clearParserMetrics,
    clearResplitMetrics,
  }),
  ...createProviderHandlers({
    getProvidersState,
    saveProvider,
    deleteProvider,
    setActiveProvider,
    sanitizeProvider,
    sanitizeProvidersState,
  }),
  ...createDataManagementHandlers({
    pipelineSupervisor,
    chatService,
    getStorageOverview,
    clearAllExtensionData,
    metricsClears: [clearLlmMetrics, clearParserMetrics, clearResplitMetrics, clearChatToolMetrics],
  }),
};

/**
 * Pure dispatch over {@link MESSAGE_HANDLERS}. See dispatch.js for the rules it
 * owns; pass a third argument to dispatch against a different registry.
 * @type {function(object, object, object=): Promise<object>}
 */
export const dispatchMessage = createDispatcher({
  handlers: MESSAGE_HANDLERS,
  isExtensionPageSender,
});

/**
 * @param {string} key
 * @returns {Promise<void>}
 */
export const startPipeline = (key) => pipelineSupervisor.startPipeline(key);

/**
 * @param {object} submission
 * @returns {Promise<{ok: boolean, key: string, error: string}>}
 */
export const handleSubmit = (submission) => handleSubmitImpl(submission);

/** Clears the in-memory job registry. Exposed for testing only. */
export function _resetJobRegistry() {
  pipelineSupervisor.reset();
}

// Listener registration must stay synchronous in this top-level body: MV3 only
// delivers an event to a cold-started worker if the listener existed by the end
// of the initial module evaluation.
installBackgroundRuntime({
  chromeRuntime: chrome.runtime,
  chromeAlarms: chrome.alarms,
  chromeStorage: chrome.storage,
  dispatchMessage,
  pipelineSupervisor,
  scheduleActionProgressIconRefresh,
});

// Repair interrupted page/index writes before reconciling their dependent
// chats. Reconciliation rebuilds projections from authoritative record meta,
// including fields added by newer versions, so no separate schema migration is
// needed. Both routines are idempotent and share the global mutation queue with
// normal writes, so startup races cannot resurrect deleted data.
void (async () => {
  try {
    await reconcileRecordStorage();
    await reconcileChatStorage();
  } catch (err) {
    log.warn('storage reconciliation failed:', err);
  }
})();

// Keep the shared pipeline concurrency limit in step with the options page.
// The subscription is intentionally never torn down: it is scoped to the
// service worker itself, and MV3 termination drops the listener with the whole
// realm, so there is no unsubscribe for this worker to own.
subscribeToLlmConcurrency(browserLocalStore.subscribe);

void refreshActionProgressIcon();
