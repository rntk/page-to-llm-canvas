import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  PROVIDER_DEFINITIONS,
  SERVICE_TIER_DEFINITIONS,
  getProviderDefinition,
} from '../../worker/providers.js';
import {
  shouldWarnTokenWipe,
  actionConfirmPrompt,
  createEmptyProviderForm,
  normalizeProvidersResponse,
  providerToForm,
  updateProviderFormField,
  updateProviderFormType,
  safeFilenamePart,
  actionResponseError,
  recordActionRouting,
  normalizeImportedRecords,
  dedupeImportedRecords,
} from './optionsLogic.js';
import { createThemeController, themeCycle, themeIcon, themeLabel } from '../../theme.js';
import { retryRecord } from '../utils/errorUtils.js';
import RecordErrorDialog from './RecordErrorDialog.jsx';
import { MSG } from '../../messages.js';
import {
  HIGHLIGHT_COLOR_KEY,
  DEFAULT_HIGHLIGHT_COLOR,
  getStoredHighlightColor,
  setStoredHighlightColor,
  normalizeHighlightColor,
  applyHighlightColorToElement,
} from '../highlightSettings.js';
import {
  PREFER_CONTENT_LANGUAGE_KEY,
  DEFAULT_PREFER_CONTENT_LANGUAGE,
  getStoredPreferContentLanguage,
  setStoredPreferContentLanguage,
  normalizePreferContentLanguage,
} from '../../worker/languageSettings.js';
import {
  SUMMARIES_DISABLED_KEY,
  DEFAULT_SUMMARIES_DISABLED,
  getStoredSummariesDisabled,
  setStoredSummariesDisabled,
  normalizeSummariesDisabled,
} from '../../worker/summarySettings.js';
// Isolated LLM duration metrics — delete with worker/llmMetrics.js to remove.
import {
  LLM_METRICS_KEY,
  emptyLlmMetrics,
  getLlmMetrics,
  clearLlmMetrics,
  averageDurationMs,
  formatDurationMs,
  formatTaskTypeLabel,
  listTaskTypes,
  normalizeLlmMetrics,
} from '../../worker/llmMetrics.js';

export function ThemeToggle() {
  const [controller] = useState(() => createThemeController());
  const [state, setState] = useState(() => controller.current());

  useEffect(() => {
    const unsubscribe = controller.subscribe(setState);
    void controller.init();
    return unsubscribe;
  }, [controller]);

  return (
    <div className="theme-toggle" role="group" aria-label="Color theme">
      {themeCycle(state.allowSystem).map((option) => (
        <button
          key={option}
          type="button"
          className={`theme-option${state.preference === option ? ' active' : ''}`}
          aria-pressed={state.preference === option}
          onClick={() => controller.setPreference(option)}
        >
          {themeIcon(option)} {themeLabel(option)}
        </button>
      ))}
    </div>
  );
}

const HIGHLIGHT_PERSIST_DEBOUNCE_MS = 150;

export function HighlightColorSection() {
  const [color, setColor] = useState(DEFAULT_HIGHLIGHT_COLOR);
  // Pending debounced write: the timer and the value waiting to be persisted.
  const persistTimer = useRef(null);
  const pendingColor = useRef(null);

  // Update local state + the live DOM preview without touching storage.
  const previewColor = useCallback((nextColor) => {
    const normalized = normalizeHighlightColor(nextColor);
    setColor(normalized);
    applyHighlightColorToElement(document.documentElement, normalized);
    return normalized;
  }, []);

  // Write to storage; if the write fails, resync the UI to what is actually
  // persisted instead of leaving it showing an unsaved value.
  const persistColor = useCallback(
    async (normalized) => {
      try {
        await setStoredHighlightColor(normalized);
      } catch (_) {
        const stored = await getStoredHighlightColor();
        previewColor(stored);
      }
    },
    [previewColor],
  );

  const flushPendingPersist = useCallback(() => {
    if (persistTimer.current) {
      clearTimeout(persistTimer.current);
      persistTimer.current = null;
    }
    if (pendingColor.current != null) {
      const next = pendingColor.current;
      pendingColor.current = null;
      void persistColor(next);
    }
  }, [persistColor]);

  useEffect(() => {
    let isCurrent = true;

    async function loadHighlightColor() {
      const stored = await getStoredHighlightColor();
      if (!isCurrent) return;
      previewColor(stored);
    }

    void loadHighlightColor();
    const handleStorageChange = (changes, areaName) => {
      if (areaName !== 'local' || !changes || !changes[HIGHLIGHT_COLOR_KEY]) return;
      previewColor(changes[HIGHLIGHT_COLOR_KEY].newValue);
    };
    try {
      chrome.storage.onChanged.addListener(handleStorageChange);
    } catch (_) {
      /* noop */
    }
    return () => {
      isCurrent = false;
      try {
        chrome.storage.onChanged.removeListener(handleStorageChange);
      } catch (_) {
        /* noop */
      }
      // Don't lose a write still sitting in the debounce window.
      flushPendingPersist();
    };
  }, [previewColor, flushPendingPersist]);

  // Live preview fires on every drag tick; the storage write is debounced so a
  // single drag does not flood every tab with storage.onChanged broadcasts.
  const handleColorInput = useCallback(
    (nextColor) => {
      const normalized = previewColor(nextColor);
      pendingColor.current = normalized;
      if (persistTimer.current) clearTimeout(persistTimer.current);
      persistTimer.current = setTimeout(() => {
        persistTimer.current = null;
        const next = pendingColor.current;
        pendingColor.current = null;
        if (next != null) void persistColor(next);
      }, HIGHLIGHT_PERSIST_DEBOUNCE_MS);
    },
    [previewColor, persistColor],
  );

  const resetColor = useCallback(() => {
    if (persistTimer.current) {
      clearTimeout(persistTimer.current);
      persistTimer.current = null;
    }
    pendingColor.current = null;
    const normalized = previewColor(DEFAULT_HIGHLIGHT_COLOR);
    void persistColor(normalized);
  }, [previewColor, persistColor]);

  return (
    <div className="settings-group">
      <h3>Highlight color</h3>
      <div className="highlight-color-control">
        <label htmlFor="highlight-color">Text and picked block highlight</label>
        <div className="highlight-color-row">
          <input
            id="highlight-color"
            type="color"
            value={color}
            onChange={(event) => handleColorInput(event.target.value)}
          />
          <span className="highlight-color-swatch" aria-hidden="true" />
          <span className="mono">{color}</span>
          <button type="button" onClick={resetColor}>
            Reset
          </button>
        </div>
        <div className="note">
          Used for sentence highlights, source preview highlights, and picked block backgrounds.
        </div>
      </div>
    </div>
  );
}

export function ContentLanguageSection() {
  const [preferContentLanguage, setPreferContentLanguage] = useState(
    DEFAULT_PREFER_CONTENT_LANGUAGE,
  );

  useEffect(() => {
    let isCurrent = true;

    async function loadPreference() {
      const stored = await getStoredPreferContentLanguage();
      if (isCurrent) setPreferContentLanguage(stored);
    }

    void loadPreference();
    const handleStorageChange = (changes, areaName) => {
      if (areaName !== 'local' || !changes || !changes[PREFER_CONTENT_LANGUAGE_KEY]) return;
      setPreferContentLanguage(
        normalizePreferContentLanguage(changes[PREFER_CONTENT_LANGUAGE_KEY].newValue),
      );
    };
    try {
      chrome.storage.onChanged.addListener(handleStorageChange);
    } catch (_) {
      /* noop */
    }
    return () => {
      isCurrent = false;
      try {
        chrome.storage.onChanged.removeListener(handleStorageChange);
      } catch (_) {
        /* noop */
      }
    };
  }, []);

  const handleToggle = useCallback(async (next) => {
    // Optimistic update; on a write failure resync to what is actually stored.
    setPreferContentLanguage(next);
    try {
      await setStoredPreferContentLanguage(next);
    } catch (_) {
      const stored = await getStoredPreferContentLanguage();
      setPreferContentLanguage(stored);
    }
  }, []);

  return (
    <div className="settings-group">
      <h3>Language</h3>
      <div className="field">
        <label htmlFor="prefer-content-language">
          <input
            id="prefer-content-language"
            type="checkbox"
            checked={preferContentLanguage}
            onChange={(event) => handleToggle(event.target.checked)}
          />{' '}
          Prefer the language of the content
        </label>
        <div className="note">
          When enabled, topic labels and summaries are written in the dominant language of the
          analyzed content instead of always defaulting to English.
        </div>
      </div>
    </div>
  );
}

export function LlmMetricsSection() {
  const [metrics, setMetrics] = useState(() => emptyLlmMetrics());
  const [isClearing, setIsClearing] = useState(false);

  useEffect(() => {
    let isCurrent = true;

    async function loadMetrics() {
      const stored = await getLlmMetrics();
      if (isCurrent) setMetrics(stored);
    }

    void loadMetrics();
    const handleStorageChange = (changes, areaName) => {
      if (areaName !== 'local' || !changes || !changes[LLM_METRICS_KEY]) return;
      setMetrics(normalizeLlmMetrics(changes[LLM_METRICS_KEY].newValue));
    };
    try {
      chrome.storage.onChanged.addListener(handleStorageChange);
    } catch (_) {
      /* noop */
    }
    return () => {
      isCurrent = false;
      try {
        chrome.storage.onChanged.removeListener(handleStorageChange);
      } catch (_) {
        /* noop */
      }
    };
  }, []);

  const handleClear = useCallback(async () => {
    setIsClearing(true);
    try {
      await clearLlmMetrics();
      setMetrics(emptyLlmMetrics());
    } catch (_) {
      const stored = await getLlmMetrics();
      setMetrics(stored);
    } finally {
      setIsClearing(false);
    }
  }, []);

  const avg = averageDurationMs(metrics);
  const taskTypes = listTaskTypes(metrics);

  return (
    <section className="section">
      <h2>LLM Request Metrics</h2>
      <div className="toolbar">
        <div className="note">
          Duration of model requests made while processing pages (includes retries), separated by
          pipeline task type.
        </div>
        <div>
          <button
            type="button"
            onClick={handleClear}
            disabled={isClearing || metrics.totalCount === 0}
          >
            {isClearing ? 'Clearing...' : 'Clear metrics'}
          </button>
        </div>
      </div>
      {metrics.totalCount === 0 ? (
        <div className="empty">No LLM requests recorded yet.</div>
      ) : (
        <>
          <div className="field">
            <table>
              <tbody>
                <tr>
                  <th scope="row">Total requests</th>
                  <td className="mono">{metrics.totalCount}</td>
                </tr>
                <tr>
                  <th scope="row">Succeeded / failed</th>
                  <td className="mono">
                    {metrics.successCount} / {metrics.failureCount}
                  </td>
                </tr>
                <tr>
                  <th scope="row">Average</th>
                  <td className="mono">{formatDurationMs(avg)}</td>
                </tr>
                <tr>
                  <th scope="row">Min / max</th>
                  <td className="mono">
                    {formatDurationMs(metrics.minDurationMs)} /{' '}
                    {formatDurationMs(metrics.maxDurationMs)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          {taskTypes.length > 0 ? (
            <div className="field">
              <div className="note note--stacked">By task type</div>
              <table>
                <thead>
                  <tr>
                    <th>Task</th>
                    <th>Requests</th>
                    <th>Ok / err</th>
                    <th>Average</th>
                    <th>Min / max</th>
                  </tr>
                </thead>
                <tbody>
                  {taskTypes.map((taskType) => {
                    const bucket = metrics.byTaskType[taskType] || emptyLlmMetrics();
                    return (
                      <tr key={taskType}>
                        <td>{formatTaskTypeLabel(taskType)}</td>
                        <td className="mono">{bucket.totalCount}</td>
                        <td className="mono">
                          {bucket.successCount} / {bucket.failureCount}
                        </td>
                        <td className="mono">{formatDurationMs(averageDurationMs(bucket))}</td>
                        <td className="mono">
                          {formatDurationMs(bucket.minDurationMs)} /{' '}
                          {formatDurationMs(bucket.maxDurationMs)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : null}
          {metrics.recent.length > 0 ? (
            <div className="field">
              <div className="note note--stacked">Recent requests (newest first)</div>
              <table>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Task</th>
                    <th>Duration</th>
                    <th>Result</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.recent.map((entry, index) => (
                    <tr key={`${entry.at}-${index}`}>
                      <td>{fmtDate(entry.at)}</td>
                      <td>{formatTaskTypeLabel(entry.taskType)}</td>
                      <td className="mono">{formatDurationMs(entry.durationMs)}</td>
                      <td title={entry.error || undefined}>{entry.ok ? 'ok' : 'error'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

export function SummaryGenerationSection() {
  const [summariesDisabled, setSummariesDisabled] = useState(DEFAULT_SUMMARIES_DISABLED);

  useEffect(() => {
    let isCurrent = true;

    async function loadSummariesDisabled() {
      const stored = await getStoredSummariesDisabled();
      if (isCurrent) setSummariesDisabled(stored);
    }

    void loadSummariesDisabled();
    const handleStorageChange = (changes, areaName) => {
      if (areaName !== 'local' || !changes || !changes[SUMMARIES_DISABLED_KEY]) return;
      setSummariesDisabled(normalizeSummariesDisabled(changes[SUMMARIES_DISABLED_KEY].newValue));
    };
    try {
      chrome.storage.onChanged.addListener(handleStorageChange);
    } catch (_) {
      /* noop */
    }
    return () => {
      isCurrent = false;
      try {
        chrome.storage.onChanged.removeListener(handleStorageChange);
      } catch (_) {
        /* noop */
      }
    };
  }, []);

  const handleToggle = useCallback(async (next) => {
    // Optimistic update; on a write failure resync to what is actually stored.
    setSummariesDisabled(next);
    try {
      await setStoredSummariesDisabled(next);
    } catch (_) {
      const stored = await getStoredSummariesDisabled();
      setSummariesDisabled(stored);
    }
  }, []);

  return (
    <div className="settings-group">
      <h3>Summaries</h3>
      <div className="field">
        <label htmlFor="disable-summaries">
          <input
            id="disable-summaries"
            type="checkbox"
            checked={summariesDisabled}
            onChange={(event) => handleToggle(event.target.checked)}
          />{' '}
          Disable summary generation
        </label>
        <div className="note">
          When enabled, processing stops after topic detection: topic labels and article structure
          are still computed, but no summaries are generated. Existing records keep their summaries
          until reprocessed. Records processed without summaries get a &quot;Generate
          summaries&quot; action below, which fills in the summaries from the already-computed
          topics without reprocessing the page.
        </div>
      </div>
    </div>
  );
}

function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleString();
}

function sendMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => resolve(resp));
  });
}

async function listProviders() {
  const resp = await sendMessage({ type: MSG.listProviders });
  return normalizeProvidersResponse(resp);
}

async function listRecords() {
  const resp = await sendMessage({ type: MSG.listRecords });
  return (resp && resp.ok && resp.items) || [];
}

function readJsonFile(file) {
  if (!file) return Promise.reject(new Error('No file selected'));
  return file.text().then((text) => JSON.parse(text));
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

function statusClass(status) {
  return `status ${status || ''}`.trim();
}

const IN_FLIGHT_STATUSES = new Set(['pending', 'splitting', 'summarizing']);

function providerTypeLabel(type) {
  return getProviderDefinition(type)?.displayName || type;
}

export function ProvidersSection() {
  const [providers, setProviders] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [form, setForm] = useState(() => createEmptyProviderForm());
  const [error, setError] = useState('');
  const [isFormOpen, setIsFormOpen] = useState(false);

  const applyProviders = useCallback((next) => {
    if (!next) return;
    setProviders(next.providers);
    setActiveId(next.activeId);
  }, []);

  const load = useCallback(async () => {
    applyProviders(await listProviders());
  }, [applyProviders]);

  useEffect(() => {
    let isCurrent = true;

    async function loadInitialProviders() {
      const next = await listProviders();
      if (isCurrent) applyProviders(next);
    }

    void loadInitialProviders();
    return () => {
      isCurrent = false;
    };
  }, [applyProviders]);

  const def = getProviderDefinition(form.type);
  const requiresUrl = !!def?.requiresUrl;
  const serviceTiers = SERVICE_TIER_DEFINITIONS[form.type] || [];
  const isEditing = !!form.id;
  const editingProvider = isEditing ? providers.find((p) => p.id === form.id) : null;

  const onTypeChange = (type) => {
    const nextDef = getProviderDefinition(type);
    setForm((f) => updateProviderFormType(f, type, nextDef?.defaultModel || ''));
  };

  const setField = (key) => (e) => {
    const value = e.target.value;
    setForm((f) => updateProviderFormField(f, key, value));
  };

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (
      shouldWarnTokenWipe(editingProvider, form) &&
      !confirm(
        'Changing this OpenAI-compatible base URL will wipe the stored token for the previous URL. Save anyway?',
      )
    ) {
      return;
    }
    const resp = await sendMessage({ type: MSG.saveProvider, provider: { ...form } });
    if (!resp || !resp.ok) {
      setError((resp && resp.error) || 'Failed to save provider');
      return;
    }
    setForm(createEmptyProviderForm());
    setIsFormOpen(false);
    await load();
  };

  const edit = (p) => {
    setError('');
    setForm(providerToForm(p));
    setIsFormOpen(true);
  };

  const add = () => {
    setError('');
    setForm(createEmptyProviderForm());
    setIsFormOpen(true);
  };

  const cancel = () => {
    setForm(createEmptyProviderForm());
    setError('');
    setIsFormOpen(false);
  };

  const remove = async (id) => {
    if (!confirm('Delete this provider?')) return;
    await sendMessage({ type: MSG.deleteProvider, id });
    if (form.id === id) cancel();
    await load();
  };

  const activate = async (id) => {
    await sendMessage({ type: MSG.setActiveProvider, id });
    await load();
  };

  return (
    <section className="section">
      <div className="section-heading">
        <div>
          <h2>LLM Providers</h2>
          <div className="note">
            The pipeline uses the <strong>active</strong> provider. It will not run until one is
            configured.
          </div>
        </div>
        <button type="button" onClick={add} disabled={isFormOpen && !isEditing}>
          Add provider
        </button>
      </div>

      {providers.length === 0 ? (
        <div className="empty">No providers configured yet.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th className="active-cell">Active</th>
              <th>Name</th>
              <th>Type</th>
              <th>Model</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {providers.map((p) => (
              <tr key={p.id}>
                <td className="active-cell">
                  <input
                    type="radio"
                    name="active-provider"
                    checked={p.id === activeId}
                    onChange={() => activate(p.id)}
                    aria-label={`Set ${p.name} active`}
                  />
                </td>
                <td>
                  {p.name} {p.id === activeId ? <span className="badge">Active</span> : null}
                </td>
                <td>{providerTypeLabel(p.type)}</td>
                <td className="mono">
                  {p.model}
                  {p.serviceTier ? <span className="badge">{p.serviceTier}</span> : null}
                </td>
                <td>
                  <button type="button" onClick={() => edit(p)}>
                    Edit
                  </button>{' '}
                  <button className="danger" type="button" onClick={() => remove(p.id)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {isFormOpen ? (
        <form className="provider-form" onSubmit={submit}>
          <div className="field">
            <label htmlFor="provider-name">Name</label>
            <input
              id="provider-name"
              type="text"
              value={form.name}
              onChange={setField('name')}
              placeholder="My OpenAI key"
            />
          </div>

          <div className="field">
            <label htmlFor="provider-type">Type</label>
            <select
              id="provider-type"
              value={form.type}
              onChange={(e) => onTypeChange(e.target.value)}
            >
              {PROVIDER_DEFINITIONS.map((d) => (
                <option key={d.type} value={d.type}>
                  {d.displayName}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="provider-model">Model</label>
            <input
              id="provider-model"
              type="text"
              list="provider-model-options"
              value={form.model}
              onChange={setField('model')}
              placeholder={def?.defaultModel || 'model id'}
            />
            <datalist id="provider-model-options">
              {(def?.models || []).map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </div>

          <div className="field">
            <label htmlFor="provider-token">API key / token</label>
            <input
              id="provider-token"
              type="password"
              value={form.token}
              onChange={setField('token')}
              placeholder={requiresUrl ? 'optional' : 'sk-...'}
              aria-describedby="provider-token-note"
              autoComplete="off"
            />
            {editingProvider?.hasToken ? (
              <div id="provider-token-note" className="note">
                Leave blank to keep the stored token.
              </div>
            ) : null}
          </div>

          {requiresUrl ? (
            <div className="field full">
              <label htmlFor="provider-url">Base URL</label>
              <input
                id="provider-url"
                type="text"
                value={form.url}
                onChange={setField('url')}
                placeholder="http://localhost:8989"
              />
            </div>
          ) : null}

          {serviceTiers.length ? (
            <div className="field">
              <label htmlFor="provider-service-tier">Service tier</label>
              <select
                id="provider-service-tier"
                value={form.serviceTier}
                onChange={setField('serviceTier')}
              >
                <option value="">Provider default</option>
                {serviceTiers.map((tier) => (
                  <option key={tier.value} value={tier.value}>
                    {tier.label}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          {error ? <div className="form-error">{error}</div> : null}

          <div className="form-actions">
            <button type="submit">{isEditing ? 'Save changes' : 'Add provider'}</button>
            <button type="button" onClick={cancel}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}

const OPTION_TABS = [
  { id: 'general', label: 'General' },
  { id: 'providers', label: 'Providers' },
  { id: 'records', label: 'Records' },
  { id: 'diagnostics', label: 'Diagnostics' },
];

function tabFromHash() {
  if (typeof window === 'undefined') return OPTION_TABS[0].id;
  const candidate = window.location.hash.slice(1);
  return OPTION_TABS.some((tab) => tab.id === candidate) ? candidate : OPTION_TABS[0].id;
}

export function OptionsApp() {
  const [activeTab, setActiveTab] = useState(tabFromHash);
  const [items, setItems] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [importMessage, setImportMessage] = useState('');
  const [isImporting, setIsImporting] = useState(false);
  // Key of the record whose error dialog is open, or null when none is shown.
  const [errorDialogKey, setErrorDialogKey] = useState(null);
  const importInputRef = useRef(null);

  const selectTab = useCallback((tabId, { focus = false } = {}) => {
    setActiveTab(tabId);
    if (typeof window !== 'undefined' && window.location.hash !== `#${tabId}`) {
      window.history.replaceState(null, '', `#${tabId}`);
    }
    if (focus) document.getElementById(`options-tab-${tabId}`)?.focus();
  }, []);

  useEffect(() => {
    const handleHashChange = () => setActiveTab(tabFromHash());
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  const handleTabKeyDown = (event) => {
    const currentIndex = OPTION_TABS.findIndex((tab) => tab.id === activeTab);
    let nextIndex = currentIndex;
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % OPTION_TABS.length;
    else if (event.key === 'ArrowLeft') {
      nextIndex = (currentIndex - 1 + OPTION_TABS.length) % OPTION_TABS.length;
    } else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = OPTION_TABS.length - 1;
    else return;
    event.preventDefault();
    selectTab(OPTION_TABS[nextIndex].id, { focus: true });
  };

  const applyRecords = useCallback((nextItems) => {
    setItems(nextItems);
    setIsLoading(false);
  }, []);

  const loadRecords = useCallback(async () => {
    setIsLoading(true);
    applyRecords(await listRecords());
  }, [applyRecords]);

  useEffect(() => {
    let isCurrent = true;

    async function loadInitialRecords() {
      const nextItems = await listRecords();
      if (isCurrent) applyRecords(nextItems);
    }

    void loadInitialRecords();
    return () => {
      isCurrent = false;
    };
  }, [applyRecords]);

  const deleteAll = async () => {
    setError('');
    setImportMessage('');
    if (!confirm('Delete ALL records?')) return;
    const resp = await sendMessage({ type: MSG.deleteAll });
    if (!resp || !resp.ok) {
      setError((resp && resp.error) || 'Failed to delete all records');
      return;
    }
    await loadRecords();
  };

  const runAction = async (action, key) => {
    setError('');
    setImportMessage('');

    const confirmPrompt = actionConfirmPrompt(action);
    if (confirmPrompt !== null && !confirm(confirmPrompt)) return;
    const { messageType } = recordActionRouting(action);

    if (action === 'open') {
      if (
        typeof chrome !== 'undefined' &&
        chrome.runtime &&
        typeof chrome.runtime.getURL === 'function'
      ) {
        const url = chrome.runtime.getURL('modal.html') + '?key=' + encodeURIComponent(key);
        window.open(url, '_blank');
        return;
      }
      alert('Open by re-picking the same blocks on the source page.');
      return;
    }

    if (
      action === 'delete' ||
      action === 'reprocess' ||
      action === 'generateSummaries' ||
      action === 'stop'
    ) {
      const resp = await sendMessage({ type: messageType, key });
      if (!resp || !resp.ok) {
        setError(actionResponseError(resp, action));
        return;
      }
      await loadRecords();
      return;
    }

    if (action === 'exportData') {
      const resp = await sendMessage({ type: messageType, key });
      if (!resp || !resp.ok || !resp.record) {
        setError(actionResponseError(resp, action));
        return;
      }
      downloadJsonFile(`pagetollm-data-${safeFilenamePart(key)}.json`, resp.record);
    }
  };

  // Retry from the error dialog: kicks off a fresh pipeline run for the record,
  // then reloads the list and closes the dialog. Rejects propagate to the
  // dialog so a failed send just re-enables its buttons.
  const retryFromErrorDialog = async () => {
    if (!errorDialogKey) return;
    await retryRecord(errorDialogKey, 'Options');
    setErrorDialogKey(null);
    await loadRecords();
  };

  const chooseImportFile = () => {
    setError('');
    setImportMessage('');
    importInputRef.current?.click();
  };

  const importFile = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    setError('');
    setImportMessage('');
    setIsImporting(true);
    try {
      const payload = await readJsonFile(file);
      const records = dedupeImportedRecords(normalizeImportedRecords(payload));
      if (records.length === 0) {
        setError('No importable records found in that file');
        return;
      }
      const existingKeys = new Set(items.map((item) => item.key));
      const collisions = records.filter((record) => existingKeys.has(record.key));
      if (
        collisions.length > 0 &&
        !confirm(
          `Importing will overwrite ${collisions.length} existing ${
            collisions.length === 1 ? 'record' : 'records'
          }. Continue?`,
        )
      ) {
        return;
      }
      const resp = await sendMessage({ type: MSG.importRecords, records });
      if (!resp || !resp.ok) {
        setError((resp && resp.error) || 'Failed to import records');
        return;
      }
      const count = resp.count || records.length;
      setImportMessage(`Imported ${count} ${count === 1 ? 'record' : 'records'}.`);
      await loadRecords();
    } catch (err) {
      setError(
        err instanceof SyntaxError ? 'Import file is not valid JSON' : 'Failed to import records',
      );
    } finally {
      setIsImporting(false);
    }
  };

  // Resolve the open dialog against the live list so it auto-closes if the
  // record is reloaded away from `error` (e.g. after a successful retry).
  const errorDialogItem = errorDialogKey
    ? items.find((item) => item.key === errorDialogKey && item.status === 'error')
    : null;

  return (
    <main className="options-shell">
      <div className="page-header">
        <div>
          <h1>PageToLLM Canvas</h1>
          <div className="page-kicker">Settings</div>
        </div>
      </div>

      <div className="options-tabs" role="tablist" aria-label="Settings sections">
        {OPTION_TABS.map((tab) => (
          <button
            id={`options-tab-${tab.id}`}
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            aria-controls={`options-panel-${tab.id}`}
            tabIndex={activeTab === tab.id ? 0 : -1}
            onClick={() => selectTab(tab.id)}
            onKeyDown={handleTabKeyDown}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <section
        id="options-panel-general"
        className="tab-panel"
        role="tabpanel"
        aria-labelledby="options-tab-general"
        hidden={activeTab !== 'general'}
      >
        <h2>General</h2>
        <div className="settings-list">
          <div className="settings-group">
            <h3>Theme</h3>
            <div>
              <ThemeToggle />
              <div className="note">
                Choose how the settings and canvas interface are displayed.
              </div>
            </div>
          </div>
          <ContentLanguageSection />
          <SummaryGenerationSection />
          <HighlightColorSection />
        </div>
      </section>

      <div
        id="options-panel-providers"
        className="tab-panel"
        role="tabpanel"
        aria-labelledby="options-tab-providers"
        hidden={activeTab !== 'providers'}
      >
        <ProvidersSection />
      </div>

      <section
        id="options-panel-records"
        className="tab-panel section"
        role="tabpanel"
        aria-labelledby="options-tab-records"
        hidden={activeTab !== 'records'}
      >
        <h2>Stored Records</h2>
        <div className="toolbar">
          <div className="note">Open dynamically inside a standalone tab.</div>
          <div>
            <input
              ref={importInputRef}
              type="file"
              accept="application/json,.json"
              onChange={importFile}
              style={{ display: 'none' }}
              aria-label="Import records JSON"
            />
            <button type="button" onClick={chooseImportFile} disabled={isImporting}>
              {isImporting ? 'Importing...' : 'Import data'}
            </button>{' '}
            <button className="danger" type="button" onClick={deleteAll}>
              Delete all
            </button>
          </div>
        </div>
        <div id="content">
          {error ? <div className="form-error form-error--stacked">{error}</div> : null}
          {importMessage ? <div className="note note--stacked">{importMessage}</div> : null}
          {isLoading ? (
            <div className="empty">Loading records...</div>
          ) : items.length === 0 ? (
            <div className="empty">No records yet. Use the popup to pick blocks on a page.</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Source</th>
                  <th>Created</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.key}>
                    <td className="url">
                      <div className="record-url">
                        {item.sourceUrl ? (
                          <a href={item.sourceUrl} target="_blank" rel="noopener noreferrer">
                            {item.sourceUrl}
                          </a>
                        ) : (
                          '(no url)'
                        )}
                      </div>
                      {item.snippet ? (
                        <div className="record-snippet" title={item.snippet}>
                          {item.snippet}
                        </div>
                      ) : null}
                    </td>
                    <td>{fmtDate(item.createdAt)}</td>
                    <td>
                      {item.status === 'error' ? (
                        <button
                          type="button"
                          className={`${statusClass(item.status)} status-button`}
                          title="View error details and retry"
                          onClick={() => setErrorDialogKey(item.key)}
                        >
                          {item.status} ⚠️
                        </button>
                      ) : (
                        <span className={statusClass(item.status)} title={item.error || undefined}>
                          {item.status || 'unknown'}
                        </span>
                      )}
                    </td>
                    <td>
                      <button type="button" onClick={() => runAction('open', item.key)}>
                        Open
                      </button>{' '}
                      <button type="button" onClick={() => runAction('reprocess', item.key)}>
                        Reprocess
                      </button>{' '}
                      {item.status === 'done' && item.summariesDisabled ? (
                        <>
                          <button
                            type="button"
                            title="Generate summaries from the already-computed topics, without reprocessing the page"
                            onClick={() => runAction('generateSummaries', item.key)}
                          >
                            Generate summaries
                          </button>{' '}
                        </>
                      ) : null}
                      {IN_FLIGHT_STATUSES.has(item.status) ? (
                        <>
                          <button type="button" onClick={() => runAction('stop', item.key)}>
                            Stop
                          </button>{' '}
                        </>
                      ) : null}
                      <button type="button" onClick={() => runAction('exportData', item.key)}>
                        Export data
                      </button>{' '}
                      <button
                        className="danger"
                        type="button"
                        onClick={() => runAction('delete', item.key)}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <div
        id="options-panel-diagnostics"
        className="tab-panel"
        role="tabpanel"
        aria-labelledby="options-tab-diagnostics"
        hidden={activeTab !== 'diagnostics'}
      >
        <LlmMetricsSection />
      </div>

      {errorDialogItem ? (
        <RecordErrorDialog
          sourceUrl={errorDialogItem.sourceUrl}
          errorText={errorDialogItem.error}
          onRetry={retryFromErrorDialog}
          onClose={() => setErrorDialogKey(null)}
        />
      ) : null}
    </main>
  );
}
