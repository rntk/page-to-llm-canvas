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
  buildRecordMetadata,
  safeFilenamePart,
  actionResponseError,
  recordActionRouting,
} from './optionsLogic.js';
import { createThemeController, themeCycle, themeIcon, themeLabel } from '../../theme.js';
import {
  HIGHLIGHT_COLOR_KEY,
  DEFAULT_HIGHLIGHT_COLOR,
  getStoredHighlightColor,
  setStoredHighlightColor,
  normalizeHighlightColor,
  applyHighlightColorToElement,
} from '../highlightSettings.js';

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
    <section className="section">
      <h2>Highlight Color</h2>
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
    </section>
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
  const resp = await sendMessage({ type: 'listProviders' });
  return normalizeProvidersResponse(resp);
}

async function listRecords() {
  const resp = await sendMessage({ type: 'listRecords' });
  return (resp && resp.ok && resp.items) || [];
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
    const resp = await sendMessage({ type: 'saveProvider', provider: { ...form } });
    if (!resp || !resp.ok) {
      setError((resp && resp.error) || 'Failed to save provider');
      return;
    }
    setForm(createEmptyProviderForm());
    await load();
  };

  const edit = (p) => {
    setError('');
    setForm(providerToForm(p));
  };

  const cancel = () => {
    setForm(createEmptyProviderForm());
    setError('');
  };

  const remove = async (id) => {
    if (!confirm('Delete this provider?')) return;
    await sendMessage({ type: 'deleteProvider', id });
    if (form.id === id) cancel();
    await load();
  };

  const activate = async (id) => {
    await sendMessage({ type: 'setActiveProvider', id });
    await load();
  };

  return (
    <section className="section">
      <h2>LLM Providers</h2>
      <div className="note">
        The pipeline uses the <strong>active</strong> provider. It will not run until one is
        configured.
      </div>

      {providers.length === 0 ? (
        <div className="empty">No providers configured yet. Add one below.</div>
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
          {isEditing ? (
            <button type="button" className="danger" onClick={cancel}>
              Cancel
            </button>
          ) : null}
        </div>
      </form>
    </section>
  );
}

export function OptionsApp() {
  const [items, setItems] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

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
    if (!confirm('Delete ALL records?')) return;
    const resp = await sendMessage({ type: 'deleteAll' });
    if (!resp || !resp.ok) {
      setError((resp && resp.error) || 'Failed to delete all records');
      return;
    }
    await loadRecords();
  };

  const runAction = async (action, key) => {
    setError('');

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

    if (action === 'delete' || action === 'reprocess' || action === 'stop') {
      const resp = await sendMessage({ type: messageType, key });
      if (!resp || !resp.ok) {
        setError(actionResponseError(resp, action));
        return;
      }
      await loadRecords();
      return;
    }

    if (action === 'exportMetadata') {
      const resp = await sendMessage({ type: messageType, key });
      if (!resp || !resp.ok || !resp.record) {
        setError(actionResponseError(resp, action));
        return;
      }
      const metadata = buildRecordMetadata(resp.record);
      downloadJsonFile(`pagetollm-metadata-${safeFilenamePart(key)}.json`, metadata);
    }
  };

  return (
    <>
      <div className="page-header">
        <h1>PageToLLM Canvas - Settings</h1>
        <ThemeToggle />
      </div>

      <ProvidersSection />

      <HighlightColorSection />

      <section className="section">
        <h2>Stored Records</h2>
        <div className="toolbar">
          <div className="note">Open dynamically inside a standalone tab.</div>
          <button className="danger" type="button" onClick={deleteAll}>
            Delete all
          </button>
        </div>
        <div id="content">
          {error ? (
            <div className="form-error" style={{ marginBottom: '12px' }}>
              {error}
            </div>
          ) : null}
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
                      <div className="record-url">{item.sourceUrl || '(no url)'}</div>
                      {item.snippet ? (
                        <div className="record-snippet" title={item.snippet}>
                          {item.snippet}
                        </div>
                      ) : null}
                    </td>
                    <td>{fmtDate(item.createdAt)}</td>
                    <td>
                      <span className={statusClass(item.status)} title={item.error || undefined}>
                        {item.status || 'unknown'}
                        {item.status === 'error' && item.error ? ' ⚠️' : ''}
                      </span>
                    </td>
                    <td>
                      <button type="button" onClick={() => runAction('open', item.key)}>
                        Open
                      </button>{' '}
                      <button type="button" onClick={() => runAction('reprocess', item.key)}>
                        Reprocess
                      </button>{' '}
                      {IN_FLIGHT_STATUSES.has(item.status) ? (
                        <>
                          <button type="button" onClick={() => runAction('stop', item.key)}>
                            Stop
                          </button>{' '}
                        </>
                      ) : null}
                      <button type="button" onClick={() => runAction('exportMetadata', item.key)}>
                        Export metadata
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
    </>
  );
}
