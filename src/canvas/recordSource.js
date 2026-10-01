import { browserRuntimeMessenger } from '../utils/runtimeMessages.js';
import { subscribeLocalChanges } from '../shared/runtime/localStore.js';
import { MSG } from '../shared/runtime/messages.js';
import {
  recordMetaStorageKey,
  recordContentStorageKey,
  recordSummaryOutputStorageKey,
  recordDiagnosticsStorageKey,
} from '../core/storage/keys.js';

// Reuse canonical key helpers: record segments containing `:` need percent encoding.
function recordViewDocumentKeys(key) {
  return [
    recordMetaStorageKey(key),
    recordContentStorageKey(key),
    recordSummaryOutputStorageKey(key),
    recordDiagnosticsStorageKey(key),
  ];
}

export const browserRecordSource = Object.freeze({
  fetch(key) {
    return browserRuntimeMessenger.send({ type: MSG.getRecordView, key });
  },
  subscribe(key, onChange) {
    return subscribeLocalChanges(recordViewDocumentKeys(key), onChange);
  },
  /**
   * Starts the worker-side Resplit of one topic card.
   * @param {string} key Record key.
   * @param {{path: string, startSentence: number, endSentence: number}} target
   */
  resplitTopic(key, target) {
    return browserRuntimeMessenger.send({ type: MSG.resplitTopic, key, ...target });
  },
});
