import { browserRuntimeMessenger } from '../utils/runtimeMessages.js';
import { subscribeLocalChanges } from '../shared/runtime/localStore.js';
import { MSG } from '../shared/runtime/messages.js';
import {
  recordMetaStorageKey,
  recordContentStorageKey,
  recordSummaryOutputStorageKey,
  recordDiagnosticsStorageKey,
} from '../../worker/storage/keys.js';

// Physical keys are confined to this browser adapter. React consumes only the
// logical fetch/subscribe capability, and record assembly remains worker-owned.
// The canonical key helpers are reused rather than re-spelled here: they
// percent-encode the record segment, so hand-built prefixes would silently stop
// matching the writer's keys for any record key containing `:`.
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
});
