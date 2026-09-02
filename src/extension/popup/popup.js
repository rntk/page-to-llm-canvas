import { createThemeController, themeIcon, themeLabel } from '../../shared/runtime/theme.js';
import { getYouTubeVideoId } from '../../utils/youtubeTimestamp.js';
import { safeFilenamePart } from '../../utils/safeFilenamePart.js';
import { sendRuntimeMessage, sendTabMessage } from '../../utils/runtimeMessages.js';
import { MSG } from '../../shared/runtime/messages.js';
import { isInFlightPipelineStatus, PIPELINE_STATUS } from '../../shared/runtime/contracts.js';
import { browserFileHost } from '../../shared/runtime/browserHosts.js';
import { applyPipelineFailures } from '../../shared/runtime/pipelineFailures.js';
import {
  isStaleActionResponse,
  STALE_ACTION_MESSAGE,
} from '../../shared/runtime/actionResponses.js';

const pickBtn = document.getElementById('pick-btn');
const refreshBtn = document.getElementById('refresh-btn');
const themeBtn = document.getElementById('theme-btn');
const optionsLink = document.getElementById('open-options');
const recordsLink = document.getElementById('open-records');
const hostEl = document.getElementById('active-host');
const recordsEl = document.getElementById('records');
const emptyEl = document.getElementById('empty');
const errorEl = document.getElementById('error');
const countEl = document.getElementById('record-count');

const STORAGE_REFRESH_DEBOUNCE_MS = 300;

const NO_LLM_PROVIDER_MESSAGE =
  'No LLM provider configured. Add one in Options before picking blocks so PageToLLM can process the selected data.';

const NO_ACTIVE_LLM_PROVIDER_MESSAGE =
  'No active LLM provider selected. Choose an active provider in Options before picking blocks.';

let activeTab = null;
let activeHostname = '';
let activePageUrl = '';
let providerReady = false;
let refreshRequestId = 0;
let storageRefreshTimer = null;
let lastRenderedRecordsSignature = '';

export async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs[0] ? tabs[0] : null;
}

export function hostnameFromUrl(url) {
  if (!url) return '';
  try {
    return new URL(url).hostname;
  } catch (_) {
    return '';
  }
}

export function isYouTubeUrl(url) {
  return Boolean(getYouTubeVideoId(url));
}

export function normalizePageUrl(url) {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.href;
  } catch (_) {
    return String(url).split('#')[0];
  }
}

export function labelFromUrl(url) {
  if (!url) return 'Unknown page';
  try {
    const parsed = new URL(url);
    const path = parsed.pathname + (parsed.search || '');
    return path.length > 1 ? path : parsed.hostname;
  } catch (_) {
    return String(url).slice(0, 80);
  }
}

export function statusLabel(status) {
  const map = {
    [PIPELINE_STATUS.DONE]: 'Done',
    [PIPELINE_STATUS.PENDING]: 'Pending',
    [PIPELINE_STATUS.SPLITTING]: 'Processing',
    [PIPELINE_STATUS.SUMMARIZING]: 'Processing',
    [PIPELINE_STATUS.ERROR]: 'Error',
    [PIPELINE_STATUS.CANCELLED]: 'Cancelled',
    [PIPELINE_STATUS.NEEDS_ATTENTION]: 'Needs attention',
  };
  return map[status] || status || 'Unknown';
}

export function formatDate(ms) {
  if (!ms) return '';
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(ms));
  } catch (_) {
    return '';
  }
}

export function providerConfigurationMessage(state) {
  const providers = Array.isArray(state && state.providers) ? state.providers : [];
  if (providers.length === 0) return NO_LLM_PROVIDER_MESSAGE;
  if (!state || !state.activeId) return NO_ACTIVE_LLM_PROVIDER_MESSAGE;
  return '';
}

export function providerReadinessState(response, error) {
  if (error) {
    return {
      ready: false,
      disabled: true,
      error: `${error.message || 'Unable to load LLM provider settings'}. Open Options and check your LLM provider configuration.`,
    };
  }
  if (!response || !response.ok) {
    return {
      ready: false,
      disabled: true,
      error: `${responseErrorMessage(response, 'Unable to load LLM provider settings')}. Open Options and check your LLM provider configuration.`,
    };
  }
  const message = providerConfigurationMessage(response);
  return { ready: !message, disabled: Boolean(message), error: message };
}

export function getRecordActions(record) {
  const useYouTubeRail = isYouTubeUrl(record && record.sourceUrl);
  const viewActions = [];
  if (record && record.status === PIPELINE_STATUS.DONE) {
    viewActions.push(
      {
        label: 'Canvas',
        mode: 'canvas',
        description: 'Open the saved visual canvas for this page.',
      },
      {
        label: 'Hierarchy',
        mode: 'hierarchy',
        description: 'View the content structure and relationships.',
      },
      {
        label: 'Topics',
        mode: 'topics',
        ...(useYouTubeRail ? { rail: 'youtube' } : {}),
        description: 'View extracted topics from this analysis.',
      },
      {
        label: 'Summaries',
        mode: 'summaries',
        ...(useYouTubeRail ? { rail: 'youtube' } : {}),
        description: 'View generated summaries for selected content.',
      },
      {
        label: 'Chat',
        mode: 'chat',
        ...(useYouTubeRail ? { rail: 'youtube' } : {}),
        description: 'Open chat mode to ask questions about this page.',
      },
    );
  }
  const manageActions = [
    {
      kind: 'message',
      label: 'Reprocess',
      className: 'warning',
      messageType: MSG.reprocessRecord,
      confirmMessage: 'Reprocess this analysis? Existing results will be overwritten.',
      failureMessage: 'Reprocess failed',
      description: 'Run this analysis again and overwrite existing results.',
    },
  ];

  if (
    record &&
    (record.status === PIPELINE_STATUS.ERROR || record.status === PIPELINE_STATUS.CANCELLED)
  ) {
    manageActions.unshift({
      kind: 'message',
      label: 'Retry',
      className: 'primary-action',
      messageType: MSG.retryRecord,
      failureMessage: 'Retry failed',
      description: 'Resume this analysis from the point where processing stopped.',
    });
  } else if (record && record.status === PIPELINE_STATUS.NEEDS_ATTENTION) {
    manageActions.unshift({
      kind: 'message',
      label: 'Retry',
      className: 'primary-action',
      messageType: MSG.resolveSummaryErrors,
      message: { action: 'retry' },
      failureMessage: 'Retry failed',
      description: 'Retry the summaries that failed without opening the error details.',
    });
  }

  // Records finished with no summaries (global toggle) or a skipped failed
  // summary get a one-shot action that fills only missing work from stored
  // topics without redoing clean/split/topic-ranges — same path as Options.
  if (
    record &&
    record.status === PIPELINE_STATUS.DONE &&
    (record.summariesDisabled || record.summariesIncomplete)
  ) {
    manageActions.push({
      kind: 'message',
      label: 'Generate summaries',
      messageType: MSG.generateRecordSummaries,
      failureMessage: 'Generate summaries failed',
      description:
        'Generate summaries from the already-computed topics, without reprocessing the page.',
    });
  }

  if (record && isInFlightPipelineStatus(record.status)) {
    manageActions.push({
      kind: 'message',
      label: 'Stop',
      className: 'danger',
      messageType: MSG.cancelRecordProcessing,
      confirmMessage:
        'Stop processing this record? Current queued work for this page will be cancelled.',
      failureMessage: 'Failed to stop processing record',
      description: 'Cancel the processing currently queued for this page.',
    });
  }

  manageActions.push({
    kind: 'export',
    label: 'Export data',
    messageType: MSG.getRecord,
    failureMessage: 'Export failed',
    description: 'Download this saved analysis as a JSON file.',
  });

  manageActions.push({
    kind: 'message',
    label: 'Delete',
    className: 'danger',
    messageType: MSG.deleteRecord,
    confirmMessage: 'Delete this record?',
    failureMessage: 'Delete failed',
    description: 'Remove this saved analysis from the extension.',
  });

  return [...viewActions.map((action) => ({ kind: 'view', ...action })), ...manageActions];
}

export function filterRecordsForActivePage(records, activePageUrl) {
  const items = Array.isArray(records) ? records : [];
  if (!activePageUrl) return items;
  return items.filter((record) => urlsMatchActivePage(record && record.sourceUrl, activePageUrl));
}

function urlsMatchActivePage(sourceUrl, activePageUrl) {
  const normalizedSourceUrl = normalizePageUrl(sourceUrl);
  const normalizedActivePageUrl = normalizePageUrl(activePageUrl);
  if (!normalizedSourceUrl || !normalizedActivePageUrl) return false;

  const sourceYouTubeId = getYouTubeVideoId(normalizedSourceUrl);
  const activeYouTubeId = getYouTubeVideoId(normalizedActivePageUrl);
  if (sourceYouTubeId && activeYouTubeId) return sourceYouTubeId === activeYouTubeId;

  return normalizedSourceUrl === normalizedActivePageUrl;
}

export function responseErrorMessage(response, fallback) {
  if (isStaleActionResponse(response)) return STALE_ACTION_MESSAGE;
  return (response && response.error) || fallback;
}

function setError(message) {
  errorEl.textContent = message;
  errorEl.hidden = !message;
}

function setLoading() {
  recordsEl.replaceChildren();
  emptyEl.hidden = true;
  countEl.textContent = '';
  lastRenderedRecordsSignature = '';
  setError('');
}

/**
 * Finds the window of an already-open options tab, if there is one.
 *
 * `chrome.tabs.query({ url })` cannot see extension pages without the "tabs"
 * permission, but `chrome.extension.getViews` reaches our own pages without
 * requesting one.
 *
 * @returns {Window | null} The live options page window, or null when closed.
 */
function findOpenOptionsView() {
  try {
    const views = chrome.extension?.getViews?.({ type: 'tab' }) || [];
    return views.find((view) => view?.location?.pathname?.endsWith('/options.html')) || null;
  } catch (_) {
    return null;
  }
}

function openOptionsPage(hash = '') {
  if (hash) {
    // Reuse an open options tab rather than stacking a duplicate on every
    // click: the options page re-reads the hash on `hashchange`, so updating
    // it switches that tab to the requested section, and openOptionsPage()
    // focuses the tab it already lives in.
    const openView = findOpenOptionsView();
    if (openView && chrome.runtime.openOptionsPage) {
      openView.location.hash = hash;
      return chrome.runtime.openOptionsPage();
    }
    const url = chrome.runtime.getURL(`options.html${hash}`);
    if (chrome.tabs?.create) return chrome.tabs.create({ url });
    window.open(url);
    return undefined;
  }
  if (chrome.runtime.openOptionsPage) {
    return chrome.runtime.openOptionsPage();
  }
  window.open(chrome.runtime.getURL('options.html'));
  return undefined;
}

async function openRecordView(key, mode, rail) {
  if (!activeTab || !activeTab.id) return;
  try {
    const message = { action: 'openRecordView', key, mode };
    if (rail) message.rail = rail;
    const response = await sendTabMessage(activeTab.id, message);
    if (response && response.status === 'error') {
      setError(responseErrorMessage(response, 'Unable to open saved analysis'));
      return;
    }
    window.close();
  } catch (err) {
    setError('Unable to open this view on the current page.');
    console.error('PageToLLM popup: openRecordView failed', err);
  }
}

function addActionHint(button, label, description) {
  if (!description) return;
  button.title = description;
  button.setAttribute('aria-label', `${label}: ${description}`);
}

function makeAction(label, key, mode, description, isPrimary = false, rail) {
  const button = document.createElement('button');
  button.className = isPrimary ? 'action primary-action' : 'action';
  button.type = 'button';
  button.textContent = label;
  addActionHint(button, label, description);
  button.addEventListener('click', () => openRecordView(key, mode, rail));
  return button;
}

export async function handleExportAction(
  action,
  key,
  { runtimeMessage, onError, fileHost = browserFileHost },
) {
  try {
    const response = await runtimeMessage({ type: action.messageType, key });
    if (!response || !response.ok || !response.record) {
      onError(responseErrorMessage(response, action.failureMessage));
      return;
    }
    fileHost.downloadJson(`pagetollm-data-${safeFilenamePart(key)}.json`, response.record);
  } catch (err) {
    onError(err.message || String(err));
  }
}

export async function handleMessageAction(
  action,
  key,
  { confirm, runtimeMessage, onSuccess, onError },
) {
  // Destructive manage actions supply confirmMessage; additive ones (e.g.
  // Generate summaries) skip the dialog, matching the Options page UX.
  if (action.confirmMessage && !confirm(action.confirmMessage)) return;
  try {
    const response = await runtimeMessage({
      ...(action.message || {}),
      type: action.messageType,
      key,
    });
    if (!response || !response.ok || isStaleActionResponse(response)) {
      onError(responseErrorMessage(response, action.failureMessage));
      return;
    }
    await onSuccess();
  } catch (err) {
    onError(err.message || String(err));
  }
}

function makeExportAction(action, key) {
  const button = document.createElement('button');
  button.className = 'action';
  button.type = 'button';
  button.textContent = action.label;
  addActionHint(button, action.label, action.description);
  button.addEventListener('click', () =>
    handleExportAction(action, key, { runtimeMessage: sendRuntimeMessage, onError: setError }),
  );
  return button;
}

function makeMessageAction(action, key) {
  const button = document.createElement('button');
  button.className = ['action', action.className].filter(Boolean).join(' ');
  button.type = 'button';
  button.textContent = action.label;
  addActionHint(button, action.label, action.description);
  button.addEventListener('click', () =>
    handleMessageAction(action, key, {
      confirm,
      runtimeMessage: sendRuntimeMessage,
      onSuccess: () => refreshRecords(),
      onError: setError,
    }),
  );
  return button;
}

export function buildRecordDisplayData(records) {
  const items = Array.isArray(records) ? records : [];
  return {
    count: items.length,
    isEmpty: items.length === 0,
    records: items.map((record) => ({
      key: record.key,
      label: labelFromUrl(record.sourceUrl),
      sourceUrl: record.sourceUrl || '',
      snippet: record.snippet || '',
      date: formatDate(record.createdAt),
      status: record.status || 'unknown',
      badge: statusLabel(record.status),
      notice: record.pipelineFailure?.message || '',
      actions: getRecordActions(record),
    })),
  };
}

function renderRecords(records, { force = false } = {}) {
  const data = buildRecordDisplayData(records);
  const signature = JSON.stringify(data);
  if (!force && signature === lastRenderedRecordsSignature) return false;

  recordsEl.replaceChildren();
  countEl.textContent = data.count ? String(data.count) : '';
  emptyEl.hidden = !data.isEmpty;

  data.records.forEach((display) => {
    const item = document.createElement('li');
    item.className = 'record';

    const copy = document.createElement('div');
    copy.className = 'copy';

    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = display.label;
    label.title = display.sourceUrl;

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = [display.date, display.notice].filter(Boolean).join(' · ');

    copy.appendChild(label);
    if (display.snippet) {
      const snippet = document.createElement('div');
      snippet.className = 'snippet';
      snippet.textContent = display.snippet;
      snippet.title = display.snippet;
      copy.appendChild(snippet);
    }
    copy.appendChild(meta);

    const isClickableStatus =
      display.status === PIPELINE_STATUS.NEEDS_ATTENTION ||
      display.status === PIPELINE_STATUS.ERROR ||
      display.status === PIPELINE_STATUS.CANCELLED;
    const badge = document.createElement(isClickableStatus ? 'button' : 'span');
    badge.className = `badge ${display.status}`;
    badge.textContent = display.badge;
    if (isClickableStatus) {
      badge.type = 'button';
      badge.classList.add('status-button');
      badge.title =
        display.status === PIPELINE_STATUS.NEEDS_ATTENTION
          ? 'Open Options to review failed summaries and retry or skip'
          : 'Open Options to view the error and retry';
      badge.addEventListener('click', () => void openOptionsPage('#records'));
    }

    const actions = document.createElement('div');
    actions.className = 'actions';

    const viewGroup = document.createElement('div');
    viewGroup.className = 'action-group view';
    const manageGroup = document.createElement('div');
    manageGroup.className = 'action-group manage';

    let primaryAssigned = false;
    display.actions.forEach((action) => {
      if (action.kind === 'view') {
        const isPrimary = !primaryAssigned;
        primaryAssigned = true;
        viewGroup.appendChild(
          makeAction(
            action.label,
            display.key,
            action.mode,
            action.description,
            isPrimary,
            action.rail,
          ),
        );
      } else if (action.kind === 'export') {
        manageGroup.appendChild(makeExportAction(action, display.key));
      } else {
        manageGroup.appendChild(makeMessageAction(action, display.key));
      }
    });

    actions.appendChild(viewGroup);
    if (manageGroup.childElementCount > 0) actions.appendChild(manageGroup);

    item.appendChild(copy);
    item.appendChild(badge);
    item.appendChild(actions);
    recordsEl.appendChild(item);
  });
  lastRenderedRecordsSignature = signature;
  return true;
}

async function refreshProviderReadiness() {
  applyProviderReadinessState(await loadProviderReadinessState());
}

function applyProviderReadinessState(state) {
  providerReady = state.ready;
  pickBtn.disabled = state.disabled;
  setError(state.error);
}

async function loadProviderReadinessState() {
  try {
    return providerReadinessState(await sendRuntimeMessage({ type: MSG.listProviders }));
  } catch (err) {
    return providerReadinessState(null, err);
  }
}

async function refreshRecords({ showLoading = false, forceRender = false } = {}) {
  const requestId = ++refreshRequestId;
  if (showLoading) setLoading();

  try {
    const tabPromise = getActiveTab();
    const recordsPromise = sendRuntimeMessage({ type: MSG.listRecords });
    const providerPromise = loadProviderReadinessState();
    // Register rejection handlers now: tab lookup can take longer than a
    // failed background request, and the tab result should still be painted.
    const resultsPromise = Promise.allSettled([tabPromise, recordsPromise, providerPromise]);

    const nextActiveTab = await tabPromise;
    if (requestId !== refreshRequestId) return;

    activeTab = nextActiveTab;
    activePageUrl = normalizePageUrl(activeTab && activeTab.url);
    activeHostname = hostnameFromUrl(activeTab && activeTab.url);
    hostEl.textContent = activeHostname || 'Current page';
    hostEl.title = activeTab && activeTab.url ? activeTab.url : '';

    const [, recordsResult, providerResult] = await resultsPromise;
    if (requestId !== refreshRequestId) return;
    if (recordsResult.status === 'rejected') throw recordsResult.reason;
    if (providerResult.status === 'rejected') throw providerResult.reason;

    const response = recordsResult.value;
    const providerState = providerResult.value;
    if (!response || !response.ok || !Array.isArray(response.items)) {
      setError(responseErrorMessage(response, 'Unable to load saved analyses'));
      return;
    }
    const visibleItems = applyPipelineFailures(response.items, response.pipelineFailures);
    const matching = filterRecordsForActivePage(visibleItems, activePageUrl);
    renderRecords(matching, { force: forceRender });
    applyProviderReadinessState(providerState);
  } catch (err) {
    if (requestId !== refreshRequestId) return;
    setError(err?.message || String(err));
  }
}

pickBtn.addEventListener('click', async () => {
  // Resolve into a local rather than writing back to the module-scoped
  // `activeTab`. That variable is owned by refreshRecords(), which guards its
  // own writes with `refreshRequestId`; a click racing a refresh would
  // otherwise read a stale value, await, and clobber the newer tab the
  // refresh just stored.
  const tab = activeTab || (await getActiveTab());
  if (!tab || !tab.id) {
    window.close();
    return;
  }
  try {
    await refreshProviderReadiness();
    if (!providerReady) return;
    const response = await sendTabMessage(tab.id, { action: 'startSelection' });
    if (response && response.status === 'error') {
      setError(responseErrorMessage(response, 'Unable to start selection'));
      return;
    }
    window.close();
  } catch (err) {
    setError('Unable to start selection on this page.');
    console.error('PageToLLM popup: startSelection failed', err);
  }
});

refreshBtn.addEventListener('click', () =>
  refreshRecords({ showLoading: true, forceRender: true }),
);

optionsLink.addEventListener('click', () => {
  void openOptionsPage();
});

recordsLink.addEventListener('click', () => {
  void openOptionsPage('#records');
});

try {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (Object.keys(changes).some((key) => key.startsWith('pagetollm:'))) {
      if (storageRefreshTimer) clearTimeout(storageRefreshTimer);
      storageRefreshTimer = setTimeout(() => {
        storageRefreshTimer = null;
        void refreshRecords();
      }, STORAGE_REFRESH_DEBOUNCE_MS);
    }
  });
} catch (_) {
  /* noop */
}

export function setupThemeToggle(controller = createThemeController()) {
  if (!themeBtn) return controller;
  controller.subscribe((state) => {
    themeBtn.textContent = themeIcon(state.preference);
    const label = `Theme: ${themeLabel(state.preference)}`;
    themeBtn.title = `${label} (click to change)`;
    themeBtn.setAttribute('aria-label', label);
  });
  themeBtn.addEventListener('click', () => {
    void controller.cycle();
  });
  void controller.init();
  return controller;
}

setupThemeToggle();

void refreshRecords({ showLoading: true, forceRender: true });
