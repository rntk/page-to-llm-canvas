import React, { useCallback, useEffect, useState } from 'react';
import {
  PROVIDER_DEFINITIONS,
  SERVICE_TIER_DEFINITIONS,
  getProviderDefinition,
} from '../../worker/providers.js';
import { MSG } from '../../messages.js';
import {
  shouldWarnTokenWipe,
  createEmptyProviderForm,
  providerToForm,
  updateProviderFormField,
  updateProviderFormType,
} from './optionsLogic.js';
import { listProviders, sendMessage } from './optionsApi.js';

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
  const editingProvider = isEditing ? providers.find((provider) => provider.id === form.id) : null;

  const onTypeChange = (type) => {
    const nextDef = getProviderDefinition(type);
    setForm((current) => updateProviderFormType(current, type, nextDef?.defaultModel || ''));
  };

  const setField = (key) => (event) => {
    const value = event.target.value;
    setForm((current) => updateProviderFormField(current, key, value));
  };

  const submit = async (event) => {
    event.preventDefault();
    setError('');
    if (
      shouldWarnTokenWipe(editingProvider, form) &&
      !confirm(
        'Changing this OpenAI-compatible base URL will wipe the stored token for the previous URL. Save anyway?',
      )
    ) {
      return;
    }
    const response = await sendMessage({ type: MSG.saveProvider, provider: { ...form } });
    if (!response || !response.ok) {
      setError((response && response.error) || 'Failed to save provider');
      return;
    }
    setForm(createEmptyProviderForm());
    setIsFormOpen(false);
    await load();
  };

  const edit = (provider) => {
    setError('');
    setForm(providerToForm(provider));
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
            {providers.map((provider) => (
              <tr key={provider.id}>
                <td className="active-cell">
                  <input
                    type="radio"
                    name="active-provider"
                    checked={provider.id === activeId}
                    onChange={() => activate(provider.id)}
                    aria-label={`Set ${provider.name} active`}
                  />
                </td>
                <td>
                  {provider.name}{' '}
                  {provider.id === activeId ? <span className="badge">Active</span> : null}
                </td>
                <td>{providerTypeLabel(provider.type)}</td>
                <td className="mono">
                  {provider.model}
                  {provider.serviceTier ? (
                    <span className="badge">{provider.serviceTier}</span>
                  ) : null}
                </td>
                <td>
                  <button type="button" onClick={() => edit(provider)}>
                    Edit
                  </button>{' '}
                  <button className="danger" type="button" onClick={() => remove(provider.id)}>
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
              onChange={(event) => onTypeChange(event.target.value)}
            >
              {PROVIDER_DEFINITIONS.map((definition) => (
                <option key={definition.type} value={definition.type}>
                  {definition.displayName}
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
              {(def?.models || []).map((model) => (
                <option key={model} value={model} />
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
