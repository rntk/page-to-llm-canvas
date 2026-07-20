import { createThemeController, themeIcon, themeLabel } from '../../shared/runtime/theme.js';
import { getYouTubeVideoId } from '../../utils/youtubeTimestamp.js';
import { sendRuntimeMessage, sendTabMessage } from '../../utils/runtimeMessages.js';
import { MSG } from '../../shared/runtime/messages.js';

// Re-exported so popup.test.js (and other importers) keep resolving it from here.
export { getYouTubeVideoId };

const pickBtn = document.getElementById('pick-btn');
const refreshBtn = document.getElementById('refresh-btn');
const themeBtn = document.getElementById('theme-btn');
const optionsLink = document.getElementById('open-options');
const hostEl = document.getElementById('active-host');
const recordsEl = document.getElementById('records');
const emptyEl = document.getElementById('empty');
const errorEl = document.getElementById('error');
const countEl = document.getElementById('record-count');

const STORAGE_REFRESH_DEBOUNCE_MS = 300;

export const NO_LLM_PROVIDER_MESSAGE =
  'No LLM provider configured. Add one in Options before picking blocks so PageToLLM can process the selected data.';

export const NO_ACTIVE_LLM_PROVIDER_MESSAGE =
  'No active LLM provider selected. Choose an active provider in Options before picking blocks.';

let activeTab = null;
let activeHostname = '';
let activePageUrl = '';
let providerReady = false;
let refreshRequestId = 0;
let storageRefreshTimer = null;
let lastRenderedRecordsSignature = '';

// Thin re-exports so popup.test.js (and other importers) keep resolving
// these names from popup.js; the actual promise/lastError plumbing lives in
// the shared src/utils/runtimeMessages.js helper.
export function runtimeMessage(message) {
  return sendRuntimeMessage(message);
}

export function tabMessage(tabId, message) {
  return sendTabMessage(tabId, message);
}

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
    done: 'Done',
    pending: 'Pending',
    splitting: 'Processing',
    summarizing: 'Processing',
    error: 'Error',
    needs_attention: 'Needs attention',
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
  const viewActions = [
    {
      label: 'Canvas',
      mode: 'canvas',
      description: 'Open the saved visual canvas for this page.',
    },
  ];
  if (record && record.status === 'done') {
    viewActions.push(
      {
        label: 'Hierarchy',
        mode: 'hierarchy',
        description: 'View the content structure and relationships.',
      },
      {
        label: 'Topics',
        mode: 'topics',
        description: 'View extracted topics from this analysis.',
      },
      {
        label: 'Summaries',
        mode: 'summaries',
        description: 'View generated summaries for selected content.',
      },
      {
        label: 'Chat',
        mode: 'chat',
        description: 'Open chat mode to ask questions about this page.',
      },
    );
    if (isYouTubeUrl(record && record.sourceUrl)) {
      viewActions.push({
        label: 'YT Sync',
        mode: 'youtube',
        description:
          'Open a sidebar that follows the video, showing the topic/summary for the current moment.',
      });
    }
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

  // Records finished intentionally without summaries (global toggle was on at
  // process time) get a one-shot action that fills summaries from stored topics
  // without redoing clean/split/topic-ranges — same path as Options.
  if (record && record.status === 'done' && record.summariesDisabled) {
    manageActions.push({
      kind: 'message',
      label: 'Generate summaries',
      messageType: MSG.generateRecordSummaries,
      failureMessage: 'Generate summaries failed',
      description:
        'Generate summaries from the already-computed topics, without reprocessing the page.',
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

export function urlsMatchActivePage(sourceUrl, activePageUrl) {
  const normalizedSourceUrl = normalizePageUrl(sourceUrl);
  const normalizedActivePageUrl = normalizePageUrl(activePageUrl);
  if (!normalizedSourceUrl || !normalizedActivePageUrl) return false;

  const sourceYouTubeId = getYouTubeVideoId(normalizedSourceUrl);
  const activeYouTubeId = getYouTubeVideoId(normalizedActivePageUrl);
  if (sourceYouTubeId && activeYouTubeId) return sourceYouTubeId === activeYouTubeId;

  return normalizedSourceUrl === normalizedActivePageUrl;
}

export function responseErrorMessage(response, fallback) {
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

async function openRecordView(key, mode) {
  if (!activeTab || !activeTab.id) return;
  try {
    const response = await tabMessage(activeTab.id, { action: 'openRecordView', key, mode });
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

function makeAction(label, key, mode, description, isPrimary = false) {
  const button = document.createElement('button');
  button.className = isPrimary ? 'action primary-action' : 'action';
  button.type = 'button';
  button.textContent = label;
  addActionHint(button, label, description);
  button.addEventListener('click', () => openRecordView(key, mode));
  return button;
}

export function safeFilenamePart(value) {
  const cleaned = String(value || 'record')
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return cleaned || 'record';
}

function downloadJsonFile(filename, value) {
  const blob = new Blob([JSON.stringify(value, null, 2) + '\n'], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export async function handleExportAction(action, key, { runtimeMessage, onError }) {
  try {
    const response = await runtimeMessage({ type: action.messageType, key });
    if (!response || !response.ok || !response.record) {
      onError(responseErrorMessage(response, action.failureMessage));
      return;
    }
    downloadJsonFile(`pagetollm-data-${safeFilenamePart(key)}.json`, response.record);
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
    const response = await runtimeMessage({ type: action.messageType, key });
    if (!response || !response.ok) {
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
    handleExportAction(action, key, { runtimeMessage, onError: setError }),
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
      runtimeMessage,
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
      actions: getRecordActions(record),
    })),
  };
}

export function recordDisplaySignature(records) {
  return JSON.stringify(buildRecordDisplayData(records));
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
    meta.textContent = display.date;

    copy.appendChild(label);
    if (display.snippet) {
      const snippet = document.createElement('div');
      snippet.className = 'snippet';
      snippet.textContent = display.snippet;
      snippet.title = display.snippet;
      copy.appendChild(snippet);
    }
    copy.appendChild(meta);

    const badge = document.createElement(display.status === 'needs_attention' ? 'button' : 'span');
    badge.className = `badge ${display.status}`;
    badge.textContent = display.badge;
    if (display.status === 'needs_attention') {
      badge.type = 'button';
      badge.classList.add('status-button');
      badge.title = 'Open the canvas to review failed summaries and retry or skip';
      badge.addEventListener('click', () => void openRecordView(display.key, 'canvas'));
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
          makeAction(action.label, display.key, action.mode, action.description, isPrimary),
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
  try {
    const response = await runtimeMessage({ type: MSG.listProviders });
    const state = providerReadinessState(response);
    applyProviderReadinessState(state);
  } catch (err) {
    const state = providerReadinessState(null, err);
    applyProviderReadinessState(state);
  }
}

function applyProviderReadinessState(state) {
  providerReady = state.ready;
  pickBtn.disabled = state.disabled;
  setError(state.error);
}

async function loadProviderReadinessState() {
  try {
    return providerReadinessState(await runtimeMessage({ type: MSG.listProviders }));
  } catch (err) {
    return providerReadinessState(null, err);
  }
}

async function refreshRecords({ showLoading = false, forceRender = false } = {}) {
  const requestId = ++refreshRequestId;
  if (showLoading) setLoading();

  activeTab = await getActiveTab();
  if (requestId !== refreshRequestId) return;

  activePageUrl = normalizePageUrl(activeTab && activeTab.url);
  activeHostname = hostnameFromUrl(activeTab && activeTab.url);
  hostEl.textContent = activeHostname || 'Current page';
  hostEl.title = activeTab && activeTab.url ? activeTab.url : '';

  try {
    const response = await runtimeMessage({ type: MSG.listRecords });
    if (requestId !== refreshRequestId) return;

    if (!response || !response.ok || !Array.isArray(response.items)) {
      if (showLoading) {
        recordsEl.replaceChildren();
        emptyEl.hidden = true;
        lastRenderedRecordsSignature = '';
      }
      setError(responseErrorMessage(response, 'Unable to load saved analyses'));
      return;
    }
    const matching = filterRecordsForActivePage(response.items, activePageUrl);
    renderRecords(matching, { force: forceRender });
    const providerState = await loadProviderReadinessState();
    if (requestId !== refreshRequestId) return;
    applyProviderReadinessState(providerState);
  } catch (err) {
    if (requestId !== refreshRequestId) return;
    if (showLoading) {
      recordsEl.replaceChildren();
      emptyEl.hidden = true;
      lastRenderedRecordsSignature = '';
    }
    setError(err.message || String(err));
  }
}

pickBtn.addEventListener('click', async () => {
  activeTab = activeTab || (await getActiveTab());
  if (!activeTab || !activeTab.id) {
    window.close();
    return;
  }
  try {
    await refreshProviderReadiness();
    if (!providerReady) return;
    await tabMessage(activeTab.id, { action: 'startSelection' });
    window.close();
  } catch (err) {
    setError('Unable to start selection on this page.');
    console.error('PageToLLM popup: startSelection failed', err);
  }
});

refreshBtn.addEventListener('click', () =>
  refreshRecords({ showLoading: true, forceRender: true }),
);

optionsLink.addEventListener('click', (e) => {
  e.preventDefault();
  if (chrome.runtime.openOptionsPage) {
    chrome.runtime.openOptionsPage();
  } else {
    window.open(chrome.runtime.getURL('options.html'));
  }
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
