import React, { useCallback, useEffect, useRef, useState } from 'react';
import { MSG } from '../shared/runtime/messages.js';
import { isStaleActionResponse } from '../shared/runtime/actionResponses.js';
import { isInFlightPipelineStatus, PIPELINE_STATUS } from '../shared/runtime/contracts.js';
import { resolveSummaryErrors, retryRecord } from '../utils/errorUtils.js';
import SummaryErrorsOverlay from '../components/SummaryErrorsOverlay.jsx';
import RecordErrorDialog from './RecordErrorDialog.jsx';
import {
  actionConfirmPrompt,
  actionResponseError,
  recordActionRouting,
  normalizeImportedRecords,
  dedupeImportedRecords,
} from './optionsLogic.js';
import { safeFilenamePart } from '../utils/safeFilenamePart.js';
import { listRecords, sendMessage } from './optionsApi.js';

function formatDate(timestamp) {
  if (!timestamp) return '';
  return new Date(timestamp).toLocaleString();
}

function statusClass(status) {
  return `status ${status || ''}`.trim();
}

export function RecordsSection({ fileHost, pageHost }) {
  const [items, setItems] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState(null);
  const [importMessage, setImportMessage] = useState('');
  const [isImporting, setIsImporting] = useState(false);
  const [retryingKey, setRetryingKey] = useState(null);
  const [errorDialogKey, setErrorDialogKey] = useState(null);
  const [summaryErrorsDialogItem, setSummaryErrorsDialogItem] = useState(null);
  const importInputRef = useRef(null);
  const recordsRequestId = useRef(0);
  const recordsUnavailable = isLoading || Boolean(loadError);
  const hasProcessingRecords = items.some((item) => isInFlightPipelineStatus(item.status));
  const bulkActionsUnavailable = recordsUnavailable || hasProcessingRecords;

  // A failed load (transport failure or `{ok:false}`) must not be rendered as
  // "No records yet" - that reads as "you have no records" to a user who may
  // have many, and unlike the metrics sections there is nothing else here to
  // self-correct. Keep whatever list was last successfully loaded and surface
  // a distinct error state with a retry affordance instead.
  const applyRecords = useCallback(({ items: nextItems, error: nextError }) => {
    setIsLoading(false);
    if (nextItems) {
      setItems(nextItems);
      setLoadError(null);
    } else {
      setLoadError(nextError || 'Failed to load records');
    }
  }, []);

  const loadRecords = useCallback(
    async ({ background = false } = {}) => {
      const requestId = ++recordsRequestId.current;
      if (!background) setIsLoading(true);
      const result = await listRecords();
      if (requestId === recordsRequestId.current) applyRecords(result);
    },
    [applyRecords],
  );

  useEffect(() => {
    void loadRecords();
    let refreshTimer = null;
    let refreshNeeded = false;
    let disposed = false;
    const storageChanges = globalThis.chrome?.storage?.onChanged;
    const scheduleRefresh = () => {
      if (disposed || refreshTimer !== null) return;
      // Bound the wait from the first event; continuous processing logs must
      // not postpone status updates. Keep one background read in flight so
      // slow reads can finish even while more storage changes arrive.
      refreshTimer = setTimeout(async () => {
        refreshNeeded = false;
        await loadRecords({ background: true });
        refreshTimer = null;
        if (refreshNeeded) scheduleRefresh();
      }, 300);
    };
    const onStorageChanged = (changes, areaName) => {
      const affectsRecords =
        areaName === 'local' &&
        Object.keys(changes).some(
          (key) => key === 'pagetollm:index' || key.startsWith('pagetollm:rec:'),
        );
      // List responses also project session-backed pipeline failures as errors.
      const affectsFailures =
        areaName === 'session' && Object.hasOwn(changes, 'pagetollm:pipeline-failure-breakers');
      if (!affectsRecords && !affectsFailures) return;
      refreshNeeded = true;
      scheduleRefresh();
    };
    storageChanges?.addListener(onStorageChanged);
    return () => {
      disposed = true;
      recordsRequestId.current += 1;
      clearTimeout(refreshTimer);
      storageChanges?.removeListener(onStorageChanged);
    };
  }, [loadRecords]);

  const deleteAll = async () => {
    if (bulkActionsUnavailable) return;
    setError('');
    setImportMessage('');
    if (
      !pageHost.confirm(
        'Delete ALL page data? This removes selected content, sentences, topics, summaries, processing logs, and every related chat.',
      )
    )
      return;
    const response = await sendMessage({ type: MSG.deleteAll });
    if (!response || !response.ok) {
      setError((response && response.error) || 'Failed to delete all records');
      return;
    }
    await loadRecords();
  };

  const runAction = async (action, key) => {
    if (['delete', 'exportData', 'reprocess'].includes(action)) {
      const item = items.find((record) => record.key === key);
      if (recordsUnavailable || !item || isInFlightPipelineStatus(item.status)) return;
    }
    setError('');
    setImportMessage('');

    const confirmPrompt = actionConfirmPrompt(action);
    if (confirmPrompt !== null && !pageHost.confirm(confirmPrompt)) return;
    const { messageType } = recordActionRouting(action);

    if (action === 'open') {
      const path = 'modal.html?key=' + encodeURIComponent(key);
      if (pageHost.openExtensionPage(path)) return;
      pageHost.alert('Open by re-picking the same blocks on the source page.');
      return;
    }

    if (
      action === 'delete' ||
      action === 'reprocess' ||
      action === 'generateSummaries' ||
      action === 'stop'
    ) {
      const response = await sendMessage({ type: messageType, key });
      if (!response || !response.ok || isStaleActionResponse(response)) {
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
      fileHost.downloadJson(`pagetollm-data-${safeFilenamePart(key)}.json`, response.record);
    }
  };

  const retryFromErrorDialog = async () => {
    if (!errorDialogKey) return;
    await retryRecord(errorDialogKey, 'Options');
    setErrorDialogKey(null);
    await loadRecords();
  };

  const quickRetry = async (item) => {
    if (retryingKey) return;
    setError('');
    setImportMessage('');
    setRetryingKey(item.key);
    try {
      if (item.status === PIPELINE_STATUS.NEEDS_ATTENTION) {
        await resolveSummaryErrors(item.key, 'retry', 'Options');
      } else {
        await retryRecord(item.key, 'Options');
      }
      await loadRecords();
    } catch (caughtError) {
      setError(caughtError?.message || 'Retry failed');
    } finally {
      setRetryingKey(null);
    }
  };

  const resolveSummaryErrorsFromDialog = async (action) => {
    if (!summaryErrorsDialogItem) return;
    await resolveSummaryErrors(summaryErrorsDialogItem.key, action, 'Options');
    setSummaryErrorsDialogItem(null);
    await loadRecords();
  };

  const openSummaryErrorsDialog = async (item) => {
    setError('');
    const response = await sendMessage({ type: MSG.getRecord, key: item.key });
    if (!response || !response.ok || !response.record) {
      setError((response && response.error) || 'Failed to load summary errors');
      return;
    }
    setSummaryErrorsDialogItem(response.record);
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

    // Collision detection is derived from `items`, so it is only safe after a
    // successful list load. In particular, a failed refresh may leave a stale
    // list (or the initial empty value) here while records that would collide
    // remain unseen in storage.
    if (bulkActionsUnavailable) {
      setError(
        hasProcessingRecords
          ? 'Cannot import while records are processing. Wait for processing to finish.'
          : 'Cannot import while records are unavailable. Retry loading records first.',
      );
      return;
    }

    setError('');
    setImportMessage('');
    setIsImporting(true);
    try {
      const payload = await fileHost.readJson(file);
      const records = dedupeImportedRecords(normalizeImportedRecords(payload));
      if (records.length === 0) {
        setError('No importable records found in that file');
        return;
      }
      const existingKeys = new Set(items.map((item) => item.key));
      const collisions = records.filter((record) => existingKeys.has(record.key));
      if (
        collisions.length > 0 &&
        !pageHost.confirm(
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
    ? items.find(
        (item) =>
          item.key === errorDialogKey &&
          (item.status === PIPELINE_STATUS.ERROR || item.status === PIPELINE_STATUS.CANCELLED),
      )
    : null;
  const importUnavailable = bulkActionsUnavailable;

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
          <button
            type="button"
            onClick={chooseImportFile}
            disabled={isImporting || importUnavailable}
          >
            {isImporting ? 'Importing...' : 'Import data'}
          </button>{' '}
          <button
            className="danger"
            type="button"
            onClick={deleteAll}
            disabled={bulkActionsUnavailable}
          >
            Delete all page data
          </button>
        </div>
      </div>
      <div id="content">
        {error ? <div className="form-error form-error--stacked">{error}</div> : null}
        {loadError && items.length > 0 ? (
          <div className="form-error form-error--stacked">
            Couldn&apos;t refresh records: {loadError}{' '}
            <button type="button" onClick={() => void loadRecords()}>
              Retry
            </button>
          </div>
        ) : null}
        {importMessage ? <div className="note note--stacked">{importMessage}</div> : null}
        {isLoading ? (
          <div className="empty">Loading records...</div>
        ) : loadError && items.length === 0 ? (
          <div className="form-error">
            Couldn&apos;t load records: {loadError}
            <div>
              <button type="button" onClick={() => void loadRecords()}>
                Retry
              </button>
            </div>
          </div>
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
                    {item.status === PIPELINE_STATUS.ERROR ||
                    item.status === PIPELINE_STATUS.CANCELLED ||
                    item.status === PIPELINE_STATUS.NEEDS_ATTENTION ? (
                      <button
                        type="button"
                        className={`${statusClass(item.status)} status-button`}
                        title={
                          item.status === PIPELINE_STATUS.NEEDS_ATTENTION
                            ? 'Review failed summaries and retry or skip'
                            : 'View error details and retry'
                        }
                        onClick={() =>
                          item.status === PIPELINE_STATUS.NEEDS_ATTENTION
                            ? void openSummaryErrorsDialog(item)
                            : setErrorDialogKey(item.key)
                        }
                      >
                        {item.status === PIPELINE_STATUS.NEEDS_ATTENTION
                          ? 'needs attention'
                          : item.status}{' '}
                        ⚠️
                      </button>
                    ) : (
                      <span className={statusClass(item.status)} title={item.error || undefined}>
                        {item.status || 'unknown'}
                      </span>
                    )}
                  </td>
                  <td>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                      {item.status === PIPELINE_STATUS.DONE ? (
                        <button type="button" onClick={() => runAction('open', item.key)}>
                          Open
                        </button>
                      ) : null}
                      {item.status === PIPELINE_STATUS.ERROR ||
                      item.status === PIPELINE_STATUS.CANCELLED ||
                      item.status === PIPELINE_STATUS.NEEDS_ATTENTION ? (
                        <button
                          type="button"
                          title={
                            item.status === PIPELINE_STATUS.NEEDS_ATTENTION
                              ? 'Retry the summaries that failed'
                              : 'Resume processing from where it stopped'
                          }
                          disabled={retryingKey !== null}
                          onClick={() => void quickRetry(item)}
                        >
                          {retryingKey === item.key ? 'Retrying...' : 'Retry'}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        disabled={recordsUnavailable || isInFlightPipelineStatus(item.status)}
                        onClick={() => runAction('reprocess', item.key)}
                      >
                        Reprocess
                      </button>
                      {item.status === PIPELINE_STATUS.DONE &&
                      (item.summariesDisabled || item.summariesIncomplete) ? (
                        <button
                          type="button"
                          title="Generate summaries from the already-computed topics, without reprocessing the page"
                          onClick={() => runAction('generateSummaries', item.key)}
                        >
                          Generate summaries
                        </button>
                      ) : null}
                      {isInFlightPipelineStatus(item.status) ? (
                        <button type="button" onClick={() => runAction('stop', item.key)}>
                          Stop
                        </button>
                      ) : null}
                      <button
                        type="button"
                        disabled={recordsUnavailable || isInFlightPipelineStatus(item.status)}
                        onClick={() => runAction('exportData', item.key)}
                      >
                        Export data
                      </button>
                      <button
                        className="danger"
                        type="button"
                        disabled={recordsUnavailable || isInFlightPipelineStatus(item.status)}
                        onClick={() => runAction('delete', item.key)}
                      >
                        Delete
                      </button>
                    </div>
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
      {summaryErrorsDialogItem ? (
        <SummaryErrorsOverlay
          className="pagetollm-options-error-overlay"
          sourceUrl={summaryErrorsDialogItem.sourceUrl}
          summaryErrors={summaryErrorsDialogItem.summaryErrors}
          onRetry={() => resolveSummaryErrorsFromDialog('retry')}
          onSkip={() => resolveSummaryErrorsFromDialog('skip')}
          onClose={() => setSummaryErrorsDialogItem(null)}
        />
      ) : null}
    </>
  );
}
