import React, { useCallback, useEffect, useState } from 'react';
import {
  PROVIDER_DEFINITIONS,
  SERVICE_TIER_DEFINITIONS,
  getProviderDefinition,
} from '../../worker/providers.js';

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
  if (!resp || !resp.ok) return null;
  return {
    providers: resp.providers || [],
    activeId: resp.activeId || null,
  };
}

async function listRecords() {
  const resp = await sendMessage({ type: 'listRecords' });
  return (resp && resp.ok && resp.items) || [];
}

function statusClass(status) {
  return `status ${status || ''}`.trim();
}

const EMPTY_FORM = {
  id: '',
  name: '',
  type: 'openai',
  model: '',
  token: '',
  url: '',
  serviceTier: '',
};

function providerTypeLabel(type) {
  return getProviderDefinition(type)?.displayName || type;
}

export function ProvidersSection() {
  const [providers, setProviders] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
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

  const onTypeChange = (type) => {
    const nextDef = getProviderDefinition(type);
    setForm((f) => ({
      ...f,
      type,
      model: f.model || nextDef?.defaultModel || '',
      serviceTier: '',
    }));
  };

  const setField = (key) => (e) => {
    const value = e.target.value;
    setForm((f) => ({ ...f, [key]: value }));
  };

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    const resp = await sendMessage({ type: 'saveProvider', provider: { ...form } });
    if (!resp || !resp.ok) {
      setError((resp && resp.error) || 'Failed to save provider');
      return;
    }
    setForm(EMPTY_FORM);
    await load();
  };

  const edit = (p) => {
    setError('');
    setForm({
      id: p.id,
      name: p.name,
      type: p.type,
      model: p.model,
      token: '',
      url: p.url || '',
      serviceTier: p.serviceTier || '',
    });
  };

  const cancel = () => {
    setForm(EMPTY_FORM);
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
          {isEditing && providers.find((p) => p.id === form.id)?.hasToken ? (
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
    if (!confirm('Delete ALL records?')) return;
    await sendMessage({ type: 'deleteAll' });
    await loadRecords();
  };

  const runAction = async (action, key) => {
    if (action === 'delete') {
      if (!confirm('Delete this record?')) return;
      await sendMessage({ type: 'deleteRecord', key });
      await loadRecords();
      return;
    }

    if (action === 'reprocess') {
      if (!confirm('Reprocess this record? Existing results will be overwritten.')) {
        return;
      }
      await sendMessage({ type: 'reprocessRecord', key });
      await loadRecords();
      return;
    }

    if (action === 'open') {
      alert('Open by re-picking the same blocks on the source page.');
    }
  };

  return (
    <>
      <h1>PageToLLM Canvas - Settings</h1>

      <ProvidersSection />

      <section className="section">
        <h2>Stored Records</h2>
        <div className="toolbar">
          <div className="note">Open by re-picking on the source page.</div>
          <button className="danger" type="button" onClick={deleteAll}>
            Delete all
          </button>
        </div>
        <div id="content">
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
                    <td className="url">{item.sourceUrl || '(no url)'}</td>
                    <td>{fmtDate(item.createdAt)}</td>
                    <td>
                      <span className={statusClass(item.status)}>{item.status || 'unknown'}</span>
                    </td>
                    <td>
                      <button type="button" onClick={() => runAction('open', item.key)}>
                        Open
                      </button>{' '}
                      <button type="button" onClick={() => runAction('reprocess', item.key)}>
                        Reprocess
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
