import { PIPELINE_STATUS } from './contracts.js';

/**
 * Builds UI-only record projections from separately transported runtime state.
 * Persisted records and exports remain unchanged.
 * @param {object[]} records Persisted record projections.
 * @param {Record<string, object>} failures Runtime failures keyed by record key.
 * @returns {object[]}
 */
export function applyPipelineFailures(records, failures = {}) {
  return (Array.isArray(records) ? records : []).map((record) => {
    const failure = failures?.[record?.key];
    if (!failure) return record;
    return {
      ...record,
      status: PIPELINE_STATUS.ERROR,
      error: failure.message,
      pipelineFailure: failure,
    };
  });
}
