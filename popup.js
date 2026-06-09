const pickBtn = document.getElementById('pick-btn');
const refreshBtn = document.getElementById('refresh-btn');
const optionsLink = document.getElementById('open-options');
const hostEl = document.getElementById('active-host');
const recordsEl = document.getElementById('records');
const emptyEl = document.getElementById('empty');
const errorEl = document.getElementById('error');
const countEl = document.getElementById('record-count');

export const NO_LLM_PROVIDER_MESSAGE =
  'No LLM provider configured. Add one in Options before picking blocks so PageToLLM can process the selected data.';

export const NO_ACTIVE_LLM_PROVIDER_MESSAGE =
  'No active LLM provider selected. Choose an active provider in Options before picking blocks.';

let activeTab = null;
let activeHostname = '';
let activePageUrl = '';
let providerReady = false;

export function runtimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

export function tabMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
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

function responseErrorMessage(response, fallback) {
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

function makeAction(label, key, mode) {
  const button = document.createElement('button');
  button.className = 'action';
  button.type = 'button';
  button.textContent = label;
  button.addEventListener('click', () => openRecordView(key, mode));
  return button;
}

function renderRecords(records) {
  recordsEl.replaceChildren();
  countEl.textContent = records.length ? String(records.length) : '';
  emptyEl.hidden = records.length !== 0;

  records.forEach((record) => {
    const item = document.createElement('li');
    item.className = 'record';

    const copy = document.createElement('div');
    copy.className = 'copy';

    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = labelFromUrl(record.sourceUrl);
    label.title = record.sourceUrl || '';

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = formatDate(record.createdAt);

    copy.appendChild(label);
    copy.appendChild(meta);

    const badge = document.createElement('span');
    badge.className = `badge ${record.status || 'unknown'}`;
    badge.textContent = statusLabel(record.status);

    const actions = document.createElement('div');
    actions.className = 'actions';
    actions.appendChild(makeAction('Canvas', record.key, 'canvas'));
    if (record.status === 'done') {
      actions.appendChild(makeAction('Topics', record.key, 'topics'));
      actions.appendChild(makeAction('Summaries', record.key, 'summaries'));
      actions.appendChild(makeAction('Hierarchy', record.key, 'hierarchy'));
    }

    const reprocessBtn = document.createElement('button');
    reprocessBtn.className = 'action warning';
    reprocessBtn.type = 'button';
    reprocessBtn.textContent = 'Reprocess';
    reprocessBtn.addEventListener('click', async () => {
      if (!confirm('Reprocess this analysis? Existing results will be overwritten.')) return;
      try {
        const response = await runtimeMessage({ type: 'reprocessRecord', key: record.key });
        if (!response || !response.ok) {
          setError(responseErrorMessage(response, 'Reprocess failed'));
          return;
        }
        await refreshRecords();
      } catch (err) {
        setError(err.message || String(err));
      }
    });
    actions.appendChild(reprocessBtn);

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'action danger';
    deleteBtn.type = 'button';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', async () => {
      if (!confirm('Delete this record?')) return;
      try {
        const response = await runtimeMessage({ type: 'deleteRecord', key: record.key });
        if (!response || !response.ok) {
          setError(responseErrorMessage(response, 'Delete failed'));
          return;
        }
        await refreshRecords();
      } catch (err) {
        setError(err.message || String(err));
      }
    });
    actions.appendChild(deleteBtn);

    item.appendChild(copy);
    item.appendChild(badge);
    item.appendChild(actions);
    recordsEl.appendChild(item);
  });
}

async function refreshProviderReadiness() {
  try {
    const response = await runtimeMessage({ type: 'listProviders' });
    if (!response || !response.ok) {
      providerReady = false;
      pickBtn.disabled = true;
      setError(
        `${responseErrorMessage(response, 'Unable to load LLM provider settings')}. Open Options and check your LLM provider configuration.`,
      );
      return;
    }
    const message = providerConfigurationMessage(response);
    providerReady = !message;
    pickBtn.disabled = !providerReady;
    setError(message);
  } catch (err) {
    providerReady = false;
    pickBtn.disabled = true;
    setError(
      `${err.message || 'Unable to load LLM provider settings'}. Open Options and check your LLM provider configuration.`,
    );
  }
}

async function refreshRecords() {
  setLoading();
  activeTab = await getActiveTab();
  activePageUrl = normalizePageUrl(activeTab && activeTab.url);
  activeHostname = hostnameFromUrl(activeTab && activeTab.url);
  hostEl.textContent = activeHostname || 'Current page';
  hostEl.title = activeTab && activeTab.url ? activeTab.url : '';

  try {
    const response = await runtimeMessage({ type: 'listRecords' });
    if (!response || !response.ok || !Array.isArray(response.items)) {
      recordsEl.replaceChildren();
      emptyEl.hidden = true;
      setError(responseErrorMessage(response, 'Unable to load saved analyses'));
      return;
    }
    const matching = activePageUrl
      ? response.items.filter((record) => normalizePageUrl(record.sourceUrl) === activePageUrl)
      : response.items;
    renderRecords(matching);
    await refreshProviderReadiness();
  } catch (err) {
    recordsEl.replaceChildren();
    emptyEl.hidden = true;
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

refreshBtn.addEventListener('click', refreshRecords);

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
      void refreshRecords();
    }
  });
} catch (_) {
  /* noop */
}

void refreshRecords();
