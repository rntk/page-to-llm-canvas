import { PIPELINE_STATUS, isPipelineStatus } from '../../src/shared/runtime/contracts.js';

// Persisted record statuses for pipelines that are actively running or queued.
const IN_FLIGHT_STATUSES = new Set([
  PIPELINE_STATUS.PENDING,
  PIPELINE_STATUS.SPLITTING,
  PIPELINE_STATUS.SUMMARIZING,
]);

export function isInFlightStatus(status) {
  return isPipelineStatus(status) && IN_FLIGHT_STATUSES.has(status);
}

export function isInFlightRecord(record) {
  return !!record && isInFlightStatus(record.status);
}
