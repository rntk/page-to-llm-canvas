// MV3 service worker composition root: wires dependencies and Chrome listeners.
import {
  readRecord,
  readRecordView,
  writeRecord,
  updateRecord,
  listRecords,
  deleteRecord,
  deleteAll,
  findRecordByUrl,
  reconcileRecordStorage,
} from '../../core/storage/storage.js';
import {
  listChats,
  readChat,
  appendChatTurn,
  deleteChatHistory,
  reconcileChatStorage,
} from '../../core/storage/chatStorage.js';
import {
  createPipelineRunner,
  isSummaryCheckpointComplete,
  isSummaryCheckpointRevisionCurrent,
} from './pipeline/orchestrator.js';
import { callLLMDirectWithRetry, callLLMWithRetry } from '../../core/llm/llm.js';
import { createAdjustableLimiter } from '../../core/llm/concurrency.js';
import { clearLlmMetrics, recordLlmMetric, wrapCallLLMWithRetry } from '../../core/metrics/llm.js';
import { clearChatToolMetrics, recordChatToolMetric } from '../../core/metrics/chatTool.js';
import { clearParserMetrics } from '../../core/metrics/parser.js';
import { clearAllExtensionData, getStorageOverview } from '../../core/storage/dataManagement.js';
import { getStoredSummariesDisabled } from '../../core/settings/summary.js';
import { getStoredPreferContentLanguage } from '../../core/settings/language.js';
import { getStoredVerboseLogs } from '../../shared/runtime/verboseLogSettings.js';
import {
  DEFAULT_MAX_PARALLEL_LLM_REQUESTS,
  MAX_PARALLEL_LLM_REQUESTS_KEY,
  getStoredMaxParallelLlmRequests,
  normalizeMaxParallelLlmRequests,
} from '../../core/settings/llmConcurrency.js';
import {
  getActiveProvider,
  getProvidersState,
  sanitizeProvider,
  sanitizeProvidersState,
  saveProvider,
  deleteProvider,
  setActiveProvider,
} from '../../core/llm/providers.js';
import { createActionIconController, createActionIconDependencies } from './actionIcon.js';
import { createLogger } from '../../shared/runtime/log.js';
import { browserLocalStore } from '../../shared/runtime/localStore.js';
import { createPipelineSupervisor } from './pipelineSupervisor.js';
import { createPipelineFailureBreaker } from './pipelineFailureBreaker.js';
import { createChatCompletionService } from './chatCompletionService.js';
import { createSubmitRecord } from './submitRecord.js';
import { createDispatcher } from './dispatch.js';
import { installBackgroundRuntime } from './runtime.js';
import { createRecordHandlers } from './handlers/recordHandlers.js';
import { createChatHandlers } from './handlers/chatHandlers.js';
import { createMetricsHandlers } from './handlers/metricsHandlers.js';
import { createProviderHandlers } from './handlers/providerHandlers.js';
import { createDataManagementHandlers } from './handlers/dataManagementHandlers.js';
import { createNavigationHandlers } from './handlers/navigationHandlers.js';
import { createPipelineRuntime } from './pipeline/pipelineRuntime.js';

export { clearSummaryErrorFlags, getAcceptedMergeFailurePaths } from './summaryResolution.js';

const log = createLogger();

const actionIconController = createActionIconController(
  createActionIconDependencies({
    records: listRecords,
    actionApi: chrome.action,
    runtimeApi: chrome.runtime,
    globalScope: globalThis,
    logger: createLogger('action icon'),
  }),
);
const refreshActionProgressIcon = actionIconController.refresh;
const scheduleActionProgressIconRefresh = actionIconController.schedule;

const recordRepository = {
  readRecord,
  readRecordView,
  writeRecord,
  updateRecord,
  listRecords,
  deleteRecord,
  deleteAll,
  findRecordByUrl,
};

const chatRepository = { listChats, readChat, appendChatTurn, deleteChatHistory };

// Resolve Chrome namespaces at call time; tests can replace the global after import.
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

// Pipelines and chat share one provider queue. Reserve one slot for interactive
// work when the limit permits it. Construct at module load so MV3 registers the
// setting listener synchronously; worker termination disposes of that listener.
const providerLimiter = createAdjustableLimiter(DEFAULT_MAX_PARALLEL_LLM_REQUESTS, {
  reservedPrioritySlots: 1,
});
const pipelineRunner = createPipelineRunner({
  runtimeFactory: createPipelineRuntime,
  settings: {
    getPreferContentLanguage: getStoredPreferContentLanguage,
    getVerboseLogs: getStoredVerboseLogs,
    getMaxParallelLlmRequests: getStoredMaxParallelLlmRequests,
    normalizeMaxParallelLlmRequests,
    subscribeToMaxParallelLlmRequests: (onValue) =>
      browserLocalStore.subscribe(MAX_PARALLEL_LLM_REQUESTS_KEY, onValue),
  },
  providerRepository: { getActiveProvider },
  llm: { callLLMWithRetry },
  // The limiter starts at the same default used by setting normalization.
  limiterFactory: () => providerLimiter,
  telemetry: { wrapCallLLMWithRetry },
  logger: log.child('pipeline'),
});
const { runPipeline } = pipelineRunner;

function isExtensionPageSender(sender) {
  if (!chrome.runtime.id || sender?.id !== chrome.runtime.id || !sender?.url) return false;
  if (typeof chrome.runtime.getURL !== 'function') return false;
  try {
    const url = new URL(sender.url);
    url.search = '';
    url.hash = '';
    // The web-accessible modal renders inside arbitrary sites. Only the private
    // management surfaces need provider settings, exports, or destructive actions.
    return ['options.html', 'popup.html'].some((page) => url.href === chrome.runtime.getURL(page));
  } catch {
    return false;
  }
}

const pipelineSupervisor = createPipelineSupervisor({
  recordRepository,
  runPipeline,
  alarms,
  runtime: runtimeErrors,
  failureBreaker: createPipelineFailureBreaker({
    getStorageArea: () => chrome.storage.session,
    runtime: runtimeErrors,
  }),
  logger: log,
});

const chatService = createChatCompletionService({
  callLLMDirectWithRetry,
  recordLlmMetric,
  limit: (task, signal) => providerLimiter.run(task, signal, { priority: true }),
});

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
const MESSAGE_HANDLERS = {
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
  ...createChatHandlers({
    chatRepository,
    chatService,
    providerRepository: { getActiveProvider },
  }),
  ...createMetricsHandlers({
    recordChatToolMetric,
    clearChatToolMetrics,
    clearParserMetrics,
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
    metricsClears: [clearLlmMetrics, clearParserMetrics, clearChatToolMetrics],
  }),
  ...createNavigationHandlers({
    openOptionsPage: () => chrome.runtime.openOptionsPage(),
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
  // Defer access to backgroundReady until after its declaration initializes.
  bootstrapReady: () => backgroundReady,
});

// Reconcile records before their dependent chats, then resume in-flight runs on
// every cold start. This also repairs runs whose keepalive alarm was lost.
/**
 * Cold-start bootstrap promise. Never rejects; startup handlers await it to
 * preserve reconciliation before resume.
 * @type {Promise<void>}
 */
export const backgroundReady = (async () => {
  try {
    const reconciliation = await reconcileRecordStorage();
    log.info('record storage reconciliation:', reconciliation);
    await reconcileChatStorage();
  } catch (err) {
    log.warn('storage reconciliation failed:', err);
  }
  try {
    await pipelineSupervisor.resumeInFlightRecords();
  } catch (err) {
    log.warn('cold-start resume failed:', err);
  }
})();

void refreshActionProgressIcon();
