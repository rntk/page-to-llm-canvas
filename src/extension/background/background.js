// MV3 service worker composition root: wires dependencies and Chrome listeners.
import {
  readRecord,
  readRecordView,
  readRecordSummaryTreeState,
  cancelRecordSummaryTree,
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
  adoptPageChats,
  deleteDetachedChats,
  reconcileChatStorage,
} from '../../core/storage/chatStorage.js';
import {
  createPipelineRunner,
  isSummaryCheckpointComplete,
  isSummaryCheckpointRevisionCurrent,
} from './pipeline/orchestrator.js';
import { callLLMDirectWithRetry, callLLMWithRetry } from '../../core/llm/llm.js';
import { DecisionClient } from '../../core/llm/decisionClient.js';
import { createAdjustableLimiter } from '../../core/llm/concurrency.js';
import {
  clearLlmMetrics,
  recordLlmMetric,
  wrapCallLLMWithRetry,
  wrapDecide,
} from '../../core/metrics/llm.js';
import { clearChatToolMetrics, recordChatToolMetric } from '../../core/metrics/chatTool.js';
import { clearParserMetrics } from '../../core/metrics/parser.js';
import { clearAllExtensionData, getStorageOverview } from '../../core/storage/dataManagement.js';
import { getStoredSummariesDisabled } from '../../core/settings/summary.js';
import { getStoredPreferContentLanguage } from '../../core/settings/language.js';
import { getStoredDecisionSplitThreshold } from '../../core/settings/decisionThreshold.js';
import { getStoredVerboseLogs } from '../../shared/runtime/verboseLogSettings.js';
import {
  DEFAULT_MAX_PARALLEL_LLM_REQUESTS,
  MAX_PARALLEL_LLM_REQUESTS_KEY,
  getStoredMaxParallelLlmRequests,
  normalizeMaxParallelLlmRequests,
} from '../../core/settings/llmConcurrency.js';
import {
  getActiveProvider,
  getDecisionProvider,
  getProvidersState,
  sanitizeProvider,
  sanitizeProvidersState,
  saveProvider,
  deleteProvider,
  setActiveProvider,
  setTopicSplitter,
} from '../../core/llm/providers.js';
import { createActionIconController, createActionIconDependencies } from './actionIcon.js';
import { createSummaryTreeJobs } from './summaryTreeJobs.js';
import {
  canRecoverSummaryTree,
  SUMMARY_TREE_STATUS,
  SUMMARY_TREE_VERSION,
} from '../../shared/runtime/summaryTree.js';
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
import { createProjectHandlers } from './handlers/projectHandlers.js';
import { createProjectService, installProjectRuntime } from './projects.js';
import { createProjectPageChatService } from './projectPageChat.js';
import { createProjectStore } from '../../core/projects/projectStorage.js';
import { createExcerptStore } from '../../core/projects/excerpts.js';
import { createProjectExcerptService } from './projectExcerpts.js';
import { createProjectTopicTreeService } from './projectTopicTree.js';

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

const chatRepository = { listChats, readChat, appendChatTurn, deleteChatHistory, adoptPageChats };

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
// The orchestrator applies the stored user limit only when a pipeline run starts,
// so a worker woken just for chat would otherwise keep the default. Seed it once
// from storage before the first chat request; later changes arrive through the
// orchestrator's setting subscription and run-start reads. A failed read leaves
// the default and is retried by the next request instead of blocking chat.
let providerLimiterSeed = null;
function seedProviderLimiter() {
  providerLimiterSeed ??= getStoredMaxParallelLlmRequests()
    .then((value) => providerLimiter.setLimit(normalizeMaxParallelLlmRequests(value)))
    .catch((error) => {
      providerLimiterSeed = null;
      log.warn('failed to seed the LLM concurrency limit:', error);
    });
  return providerLimiterSeed;
}
const pipelineRunner = createPipelineRunner({
  runtimeFactory: createPipelineRuntime,
  settings: {
    getPreferContentLanguage: getStoredPreferContentLanguage,
    getVerboseLogs: getStoredVerboseLogs,
    getMaxParallelLlmRequests: getStoredMaxParallelLlmRequests,
    getDecisionSplitThreshold: getStoredDecisionSplitThreshold,
    normalizeMaxParallelLlmRequests,
    subscribeToMaxParallelLlmRequests: (onValue) =>
      browserLocalStore.subscribe(MAX_PARALLEL_LLM_REQUESTS_KEY, onValue),
  },
  providerRepository: { getActiveProvider, getDecisionProvider },
  llm: {
    callLLMWithRetry,
    createDecisionClient: ({ url, token, model }) =>
      new DecisionClient({ baseUrl: url, apiKey: token, model }),
  },
  // The limiter starts at the same default used by setting normalization.
  limiterFactory: () => providerLimiter,
  telemetry: { wrapCallLLMWithRetry, wrapDecide },
  logger: log.child('pipeline'),
});
const { runPipeline } = pipelineRunner;
// Pipelines and background tree builds share one runaway-recovery breaker.
const pipelineFailureBreaker = createPipelineFailureBreaker({
  getStorageArea: () => chrome.storage.session,
  runtime: runtimeErrors,
});

const summaryTreeJobs = createSummaryTreeJobs({
  runSummaryTree: pipelineRunner.runSummaryTree,
  logger: log.child('summary tree'),
  alarms,
  alarmName: 'summary-tree-keepalive',
  failureBreaker: pipelineFailureBreaker,
  onStop: cancelRecordSummaryTree,
  async canRecover(key) {
    const record = await readRecordSummaryTreeState(key);
    return (
      record?.status === 'done' &&
      canRecoverSummaryTree(record.summary_tree, record.contentRevision)
    );
  },
  async onFailure(key, error, { signal }) {
    const record = await readRecord(key);
    if (record?.status !== 'done' || record.summary_tree?.status !== SUMMARY_TREE_STATUS.RUNNING)
      return;
    await updateRecord(
      key,
      {
        summary_tree: {
          ...record.summary_tree,
          status: signal.aborted ? SUMMARY_TREE_STATUS.CANCELLED : SUMMARY_TREE_STATUS.ERROR,
          error: signal.aborted ? 'Stopped.' : String(error?.message || error),
          updatedAt: Date.now(),
        },
      },
      { expectedPipelineRunId: record.pipelineRunId, expectedStatuses: ['done'] },
    );
  },
  async prepareRun(key, { fresh }) {
    const record = await readRecord(key);
    if (record?.status !== 'done') throw new Error('The record must finish processing first.');
    const updated = await updateRecord(
      key,
      {
        summary_tree: {
          ...(!fresh && record.summary_tree?.contentRevision === record.contentRevision
            ? record.summary_tree
            : {}),
          version: SUMMARY_TREE_VERSION,
          backgroundRecovery: true,
          contentRevision: record.contentRevision,
          status: SUMMARY_TREE_STATUS.RUNNING,
          error: null,
          updatedAt: Date.now(),
        },
      },
      { expectedPipelineRunId: record.pipelineRunId, expectedStatuses: ['done'] },
    );
    if (!updated) throw new Error('The article changed before the tree build started.');
  },
  async listRunningKeys() {
    const keys = [];
    for (const item of await listRecords()) {
      if (item.status !== 'done') continue;
      const record = await readRecordSummaryTreeState(item.key);
      if (
        record?.status === 'done' &&
        canRecoverSummaryTree(record.summary_tree, record.contentRevision)
      )
        keys.push(item.key);
    }
    return keys;
  },
});

function isExtensionPageSender(sender) {
  if (!chrome.runtime.id || sender?.id !== chrome.runtime.id || !sender?.url) return false;
  if (typeof chrome.runtime.getURL !== 'function') return false;
  try {
    const url = new URL(sender.url);
    url.search = '';
    url.hash = '';
    // The web-accessible modal renders inside arbitrary sites. Only the private
    // management surfaces need provider settings, exports, or destructive actions.
    return ['options.html', 'popup.html', 'project.html'].some(
      (page) => url.href === chrome.runtime.getURL(page),
    );
  } catch {
    return false;
  }
}

// A session guard protects syncs dispatched before onStartup and survives
// worker restarts. Persist invalidation before marking cached ids trusted.
const PROJECT_BINDING_SESSION_KEY = 'pagetollm:projects-bound';
const projectStore = createProjectStore();
const projectService = createProjectService({
  tabs: {
    query: (...args) => chrome.tabs.query(...args),
    create: (...args) => chrome.tabs.create(...args),
    update: (...args) => chrome.tabs.update(...args),
    group: (...args) => chrome.tabs.group(...args),
    remove: (...args) => chrome.tabs.remove(...args),
  },
  tabGroups: {
    query: (...args) => chrome.tabGroups.query(...args),
    get: (...args) => chrome.tabGroups.get(...args),
  },
  windows: { update: (...args) => chrome.windows.update(...args) },
  getURL: (path) => chrome.runtime.getURL(path),
  projectStore,
  bindingSession: {
    async isTrusted() {
      const area = chrome.storage?.session;
      if (!area?.get) return false;
      const items = await area.get(PROJECT_BINDING_SESSION_KEY);
      return !!items?.[PROJECT_BINDING_SESSION_KEY];
    },
    async markTrusted() {
      await chrome.storage?.session?.set?.({ [PROJECT_BINDING_SESSION_KEY]: true });
    },
  },
  // A cold start rebinds tabs after the first recovery scan, which then saw no
  // recoverable merge; scan again once bindings actually change.
  onRebound: () => topicTreeService.resumeInFlight(),
  logger: log.child('projects'),
});

const topicTreeService = createProjectTopicTreeService({
  projectService,
  projectStore,
  listRecords,
  readRecord,
  runProjectTopicTree: pipelineRunner.runProjectTopicTree,
  logger: log.child('project topics'),
  alarms,
  failureBreaker: pipelineFailureBreaker,
});

const pageChatService = createProjectPageChatService({
  projectService,
  findRecordByUrl,
  sendTabMessage: (...args) => chrome.tabs.sendMessage(...args),
});

const excerptService = createProjectExcerptService({
  projectService,
  pageChatService,
  excerptStore: createExcerptStore(),
  deleteChats: deleteDetachedChats,
  sendTabMessage: (...args) => chrome.tabs.sendMessage(...args),
  logger: log.child('projects'),
});

const pipelineSupervisor = createPipelineSupervisor({
  recordRepository,
  runPipeline,
  alarms,
  runtime: runtimeErrors,
  failureBreaker: pipelineFailureBreaker,
  logger: log,
});

const chatService = createChatCompletionService({
  callLLMDirectWithRetry,
  recordLlmMetric,
  limit: async (task, signal) => {
    await seedProviderLimiter();
    return providerLimiter.run(task, signal, { priority: true });
  },
  // Any extension API call resets the MV3 idle timer.
  keepAlive: () => chrome.runtime.getPlatformInfo(),
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
    summaryTreeJobs,
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
    setTopicSplitter,
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
  ...createProjectHandlers({ projectService, pageChatService, excerptService, topicTreeService }),
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
  treeJobs: [summaryTreeJobs, topicTreeService],
  scheduleActionProgressIconRefresh,
  // Defer access to backgroundReady until after its declaration initializes.
  bootstrapReady: () => backgroundReady,
});
installProjectRuntime({
  projectService,
  excerptService,
  chromeRuntime: chrome.runtime,
  chromeTabs: chrome.tabs,
  chromeTabGroups: chrome.tabGroups,
  chromeContextMenus: chrome.contextMenus,
  chromeCommands: chrome.commands,
  logger: log.child('projects'),
  notifyActionFailure: actionIconController.flashFailure,
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
  await Promise.all([summaryTreeJobs.resumeInFlight(), topicTreeService.resumeInFlight()]);
})();

void refreshActionProgressIcon();
