/**
 * Pure (side-effect-free) logic extracted from OptionsApp.jsx.
 * No DOM, no chrome, no window/confirm/alert references.
 */

/**
 * @returns {{id: string, name: string, type: string, model: string, token: string, url: string, serviceTier: string}}
 */
export function createEmptyProviderForm() {
  return {
    id: '',
    name: '',
    type: 'openai',
    model: '',
    token: '',
    url: '',
    serviceTier: '',
  };
}

/**
 * Normalizes a provider list response from the runtime messaging layer.
 * @param {object|null|undefined} resp
 * @returns {{providers: Array, activeId: string|null}|null}
 */
export function normalizeProvidersResponse(resp) {
  if (!resp || !resp.ok) return null;
  return {
    providers: resp.providers || [],
    activeId: resp.activeId || null,
  };
}

/**
 * Builds the provider form values used when editing an existing provider.
 * Sensitive fields stay blank so the UI never re-exposes stored secrets.
 * @param {object} provider
 */
export function providerToForm(provider) {
  return {
    id: provider.id,
    name: provider.name,
    type: provider.type,
    model: provider.model,
    token: '',
    url: provider.url || '',
    serviceTier: provider.serviceTier || '',
  };
}

/**
 * Applies a field update to provider form state.
 * @param {object} form
 * @param {string} key
 * @param {string} value
 */
export function updateProviderFormField(form, key, value) {
  return { ...form, [key]: value };
}

/**
 * Applies a provider-type change while preserving the current model when one
 * is already present.
 * @param {object} form
 * @param {string} type
 * @param {string} defaultModel
 */
export function updateProviderFormType(form, type, defaultModel = '') {
  return {
    ...form,
    type,
    model: form.model || defaultModel || '',
    serviceTier: '',
  };
}

/**
 * @param {object|null|undefined} record
 * @returns {object}
 */
export function buildRecordMetadata(record) {
  if (!record || typeof record !== 'object') return {};
  const {
    html: _html,
    text: _text,
    sentences: _sentences,
    topics: _topics,
    topic_summaries: _topicSummaries,
    topic_summary_index: _topicSummaryIndex,
    ...metadata
  } = record;
  return metadata;
}

/**
 * @param {string|number|null|undefined} value
 * @returns {string}
 */
export function safeFilenamePart(value) {
  const cleaned = String(value || 'record')
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return cleaned || 'record';
}

/**
 * Returns the runtime message type and error fallback for a record action.
 * @param {'delete'|'reprocess'|'stop'|'open'|'exportMetadata'|string} action
 * @returns {{messageType: string|null, errorMessage: string}}
 */
export function recordActionRouting(action) {
  return {
    messageType: actionToMessageType(action),
    errorMessage: actionErrorMessage(action),
  };
}

/**
 * Returns the error string to surface after a failed record action response.
 * @param {object|null|undefined} resp
 * @param {'delete'|'reprocess'|'stop'|'open'|'exportMetadata'|string} action
 * @returns {string}
 */
export function actionResponseError(resp, action) {
  return (resp && resp.error) || actionErrorMessage(action);
}

/**
 * Returns true when saving an openai_comp provider edit should prompt the user
 * about wiping the stored token because the base URL changed while the token
 * field was left blank.
 *
 * @param {object|null} editingProvider  – the provider object from state (may be null)
 * @param {{ token: string, url: string }} form  – current form values
 * @returns {boolean}
 */
export function shouldWarnTokenWipe(editingProvider, form) {
  return (
    editingProvider?.type === 'openai_comp' &&
    !!editingProvider.hasToken &&
    !form.token.trim() &&
    (editingProvider.url || '') !== form.url.trim()
  );
}

/**
 * Maps a record action string to the corresponding runtime message type.
 * Returns null for actions that do not send a runtime message.
 *
 * @param {'delete'|'reprocess'|'stop'|'open'|'exportMetadata'|string} action
 * @returns {string|null}
 */
export function actionToMessageType(action) {
  const map = {
    delete: 'deleteRecord',
    reprocess: 'reprocessRecord',
    stop: 'cancelRecordProcessing',
    exportMetadata: 'getRecord',
  };
  return map[action] ?? null;
}

/**
 * Returns the confirm-dialog prompt for a given action, or null if the action
 * does not require a confirm dialog.
 *
 * @param {'delete'|'reprocess'|'stop'|'open'|'exportMetadata'|string} action
 * @returns {string|null}
 */
export function actionConfirmPrompt(action) {
  const map = {
    delete: 'Delete this record?',
    reprocess: 'Reprocess this record? Existing results will be overwritten.',
    stop: 'Stop processing this record? Current queued work for this page will be cancelled.',
  };
  return map[action] ?? null;
}

/**
 * Returns the fallback error message for a failed action response.
 *
 * @param {'delete'|'reprocess'|'stop'|'open'|'exportMetadata'|string} action
 * @returns {string}
 */
export function actionErrorMessage(action) {
  const map = {
    delete: 'Failed to delete record',
    reprocess: 'Failed to reprocess record',
    stop: 'Failed to stop processing record',
    exportMetadata: 'Failed to export record metadata',
  };
  return map[action] ?? 'Action failed';
}
