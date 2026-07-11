// Persisted record statuses for pipelines that are actively running or queued.
const IN_FLIGHT_STATUSES = new Set(['pending', 'splitting', 'summarizing']);

export function isInFlightStatus(status) {
  return IN_FLIGHT_STATUSES.has(status);
}

export function isInFlightRecord(record) {
  return !!record && isInFlightStatus(record.status);
}
