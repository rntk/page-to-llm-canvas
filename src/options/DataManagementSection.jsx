import React, { useCallback, useEffect, useState } from 'react';
import { MSG } from '../shared/runtime/messages.js';
import { sendMessage } from './optionsApi.js';

const CATEGORY_ROWS = [
  {
    id: 'pageData',
    label: 'Page data',
    description: 'Selected HTML/text, sentences, topics, summaries, processing logs, and chats',
  },
  {
    id: 'providers',
    label: 'Providers',
    description: 'Provider configuration, active provider, URLs, models, and API tokens',
  },
  {
    id: 'settings',
    label: 'Preferences',
    description:
      'Theme, highlight color, language, summary, LLM concurrency, and diagnostic-log preferences',
  },
  {
    id: 'diagnostics',
    label: 'Diagnostics',
    description: 'LLM, parser, and chat-tool counters and recent diagnostic samples',
  },
  {
    id: 'other',
    label: 'Other',
    description: 'Any unrecognized local storage keys',
  },
];

function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// A size the worker could only partially read is a lower bound, so it is
// marked distinctly from a merely estimated one: "at least this much" and
// "roughly this much" lead to different decisions about deleting data.
function sizePrefix(entry = {}) {
  if (entry.partial) return '≥';
  return entry.approximate ? '~' : '';
}

function categoryDetail(id, category = {}) {
  if (id === 'pageData') {
    return `${category.recordCount || 0} page record${category.recordCount === 1 ? '' : 's'}, ${
      category.chatCount || 0
    } chat${category.chatCount === 1 ? '' : 's'}`;
  }
  if (id === 'providers') {
    return `${category.providerCount || 0} provider${category.providerCount === 1 ? '' : 's'}`;
  }
  return `${category.keyCount || 0} stored item${category.keyCount === 1 ? '' : 's'}`;
}

export function DataManagementSection({ onDataChanged }) {
  const [overview, setOverview] = useState(null);
  const [error, setError] = useState('');
  const [busyAction, setBusyAction] = useState('');

  const refresh = useCallback(async () => {
    const response = await sendMessage({ type: MSG.getStorageOverview });
    if (!response?.ok || !response.overview) {
      setError(response?.error || 'Failed to inspect extension storage');
      return;
    }
    setOverview(response.overview);
    setError('');
  }, []);

  useEffect(() => {
    // The overview is external browser state; synchronize it after mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const deletePageData = async () => {
    if (
      !confirm(
        'Delete all page data? This removes selected content, sentences, topics, summaries, processing logs, and every related chat.',
      )
    ) {
      return;
    }
    setBusyAction('pages');
    setError('');
    const response = await sendMessage({ type: MSG.deleteAll });
    setBusyAction('');
    if (!response?.ok) {
      setError(response?.error || 'Failed to delete page data');
      return;
    }
    onDataChanged?.();
    await refresh();
  };

  const resetExtension = async () => {
    if (
      !confirm(
        'Reset ALL extension data? This permanently removes page data and chats, provider settings and API tokens, preferences, diagnostics, and unrecognized stored data.',
      )
    ) {
      return;
    }
    setBusyAction('all');
    setError('');
    const response = await sendMessage({ type: MSG.deleteAllExtensionData });
    setBusyAction('');
    if (!response?.ok) {
      setError(response?.error || 'Failed to reset extension data');
      return;
    }
    onDataChanged?.();
    await refresh();
  };

  return (
    <section className="section data-management">
      <div className="section-heading">
        <div>
          <h2>Stored Data</h2>
          <div className="note">
            Everything persisted in this browser profile is listed by category. Space is reported by
            the browser when available.
          </div>
        </div>
        <button type="button" onClick={refresh} disabled={!!busyAction}>
          Refresh
        </button>
      </div>

      {error ? <div className="form-error form-error--stacked">{error}</div> : null}
      {!overview ? (
        <div className="empty">Inspecting extension storage...</div>
      ) : (
        <>
          <table aria-label="Extension storage categories">
            <thead>
              <tr>
                <th>Category</th>
                <th>Contains</th>
                <th>Stored</th>
                <th>Space</th>
              </tr>
            </thead>
            <tbody>
              {CATEGORY_ROWS.map((row) => {
                const category = overview.categories?.[row.id] || {};
                return (
                  <tr key={row.id}>
                    <th scope="row">{row.label}</th>
                    <td>{row.description}</td>
                    <td>{categoryDetail(row.id, category)}</td>
                    <td className="mono">
                      {sizePrefix(category)}
                      {formatBytes(category.bytes)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="storage-total note">
            Total: {sizePrefix(overview)}
            {formatBytes(overview.totalBytes)} across {overview.totalKeyCount || 0} stored items.
            {overview.approximate
              ? ' Sizes marked ~ are estimated: the browser could not report exact usage.'
              : ''}
            {overview.partial
              ? ' Sizes marked ≥ are lower bounds: some stored values could not be read.'
              : ''}
          </div>
        </>
      )}

      <div className="data-actions">
        <div>
          <h3>Delete page data</h3>
          <p className="note">
            Keeps providers and preferences. Cleanup scans page and chat namespaces, including
            records left unindexed by interrupted writes.
          </p>
          <button className="danger" type="button" onClick={deletePageData} disabled={!!busyAction}>
            {busyAction === 'pages' ? 'Deleting...' : 'Delete all page data'}
          </button>
        </div>
        <div>
          <h3>Reset extension</h3>
          <p className="note">
            Removes every local value, including provider API tokens, preferences, diagnostics, and
            unrecognized keys.
          </p>
          <button className="danger" type="button" onClick={resetExtension} disabled={!!busyAction}>
            {busyAction === 'all' ? 'Resetting...' : 'Delete all extension data'}
          </button>
        </div>
      </div>
    </section>
  );
}
