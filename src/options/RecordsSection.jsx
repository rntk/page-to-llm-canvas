import React, { useCallback, useEffect, useRef, useState } from 'react';
import { MSG } from '../../messages.js';
import { retryRecord } from '../utils/errorUtils.js';
import RecordErrorDialog from './RecordErrorDialog.jsx';
import {
  actionConfirmPrompt,
  safeFilenamePart,
  actionResponseError,
  recordActionRouting,
  normalizeImportedRecords,
  dedupeImportedRecords,
} from './optionsLogic.js';
import { listRecords, sendMessage } from './optionsApi.js';

const IN_FLIGHT_STATUSES = new Set(['pending', 'splitting', 'summarizing']);

function formatDate(timestamp) {
  if (!timestamp) return '';
  return new Date(timestamp).toLocaleString();
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

export function RecordsSection() {
  const [items, setItems] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [importMessage, setImportMessage] = useState('');
  const [isImporting, setIsImporting] = useState(false);
  const [errorDialogKey, setErrorDialogKey] = useState(null);
  const importInputRef = useRef(null);

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
    const response = await sendMessage({ type: MSG.deleteAll });
    if (!response || !response.ok) {
      setError((response && response.error) || 'Failed to delete all records');
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
      const response = await sendMessage({ type: messageType, key });
      if (!response || !response.ok) {
        setError(actionResponseError(response, action));
        return;
      }
      await loadRecords();
      return;
    }

    if (action === 'exportData') {
      const response = await sendMessage({ type: messageType, key });
      if (!response || !response.ok || !response.record) {
        setError(actionResponseError(response, action));
        return;
      }
      downloadJsonFile(`pagetollm-data-${safeFilenamePart(key)}.json`, response.record);
    }
  };

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
      const response = await sendMessage({ type: MSG.importRecords, records });
      if (!response || !response.ok) {
        setError((response && response.error) || 'Failed to import records');
        return;
      }
      const count = response.count || records.length;
      setImportMessage(`Imported ${count} ${count === 1 ? 'record' : 'records'}.`);
      await loadRecords();
    } catch (caughtError) {
      setError(
        caughtError instanceof SyntaxError
          ? 'Import file is not valid JSON'
          : 'Failed to import records',
      );
    } finally {
      setIsImporting(false);
    }
  };

  const errorDialogItem = errorDialogKey
    ? items.find((item) => item.key === errorDialogKey && item.status === 'error')
    : null;

  return (
    <>
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
                  <td>{formatDate(item.createdAt)}</td>
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

      {errorDialogItem ? (
        <RecordErrorDialog
          sourceUrl={errorDialogItem.sourceUrl}
          errorText={errorDialogItem.error}
          onRetry={retryFromErrorDialog}
          onClose={() => setErrorDialogKey(null)}
        />
      ) : null}
    </>
  );
}
