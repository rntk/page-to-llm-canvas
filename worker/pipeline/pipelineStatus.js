import { isInFlightPipelineStatus } from '../../src/shared/runtime/contracts.js';

// Persisted record statuses for pipelines that are actively running or queued.
export function isInFlightStatus(status) {
  return isInFlightPipelineStatus(status);
}

export function isInFlightRecord(record) {
  return !!record && isInFlightStatus(record.status);
}
