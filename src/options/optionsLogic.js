/**
 * Pure (side-effect-free) logic extracted from OptionsApp.jsx.
 * No DOM, no chrome, no window/confirm/alert references.
 */

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
 * @param {'delete'|'reprocess'|'open'|'exportMetadata'|string} action
 * @returns {string|null}
 */
export function actionToMessageType(action) {
  const map = {
    delete: 'deleteRecord',
    reprocess: 'reprocessRecord',
    exportMetadata: 'getRecord',
  };
  return map[action] ?? null;
}

/**
 * Returns the confirm-dialog prompt for a given action, or null if the action
 * does not require a confirm dialog.
 *
 * @param {'delete'|'reprocess'|'open'|'exportMetadata'|string} action
 * @returns {string|null}
 */
export function actionConfirmPrompt(action) {
  const map = {
    delete: 'Delete this record?',
    reprocess: 'Reprocess this record? Existing results will be overwritten.',
  };
  return map[action] ?? null;
}

/**
 * Returns the fallback error message for a failed action response.
 *
 * @param {'delete'|'reprocess'|'open'|'exportMetadata'|string} action
 * @returns {string}
 */
export function actionErrorMessage(action) {
  const map = {
    delete: 'Failed to delete record',
    reprocess: 'Failed to reprocess record',
    exportMetadata: 'Failed to export record metadata',
  };
  return map[action] ?? 'Action failed';
}
