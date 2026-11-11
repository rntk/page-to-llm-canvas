/**
 * Shared loading/recovery workflow for content rail controllers.
 *
 * Owns the surface-independent steps: begin a guarded load, fetch the record,
 * drop superseded requests, report fetch failures, apply the shared lifecycle
 * assessment, route failed/parked records to Options and tell the user when
 * analysis is still in progress. Surface-specific prerequisites (page
 * selectors, transcript eligibility, …) stay with each controller and run on
 * the returned `ready` record.
 */

import { fetchRecord, describeFetchFailure, assessRecordLifecycle } from './recordFetch.js';
import { createOptionsRecoveryOpener } from './optionsRecovery.js';

/**
 * @param {{
 *   surfaceManager: { beginLoad: function(): { isStale: function(): boolean } },
 *   runtimeMessenger: { send: function(object): Promise<object|null> },
 *   alert: function(string): void,
 *   logger?: { warn: Function },
 * }} deps
 * @returns {{
 *   load: function(string, { assess?: function(object): {kind: string} }=): Promise<{
 *     guard: { isStale: function(): boolean },
 *     assessment: { kind: string, record?: object }|null,
 *   }>,
 *   openOptionsForRecovery: function(): Promise<void>,
 * }}
 */
export function createRecordLoader({ surfaceManager, runtimeMessenger, alert, logger }) {
  const openOptionsForRecovery = createOptionsRecoveryOpener({ runtimeMessenger, alert, logger });

  /**
   * Load a record for a rail. Resolves with the load `guard` (callers keep using
   * it after the await) and an `assessment`: `null` when the request was
   * superseded or the fetch failed (already reported), otherwise the surface's
   * assessment. Lifecycle outcomes other than `ready` are handled here and
   * resolve with `assessment: null`; any other kind (e.g. a surface-specific
   * `no_selectors`) is passed through for the caller to handle.
   *
   * @param {string} key
   * @param {{ assess?: function(object): {kind: string} }} [options]
   *   `assess` defaults to assessRecordLifecycle and may layer surface policy
   *   on top of it, but must return lifecycle results unchanged.
   */
  async function load(key, { assess = assessRecordLifecycle } = {}) {
    const guard = surfaceManager.beginLoad();
    const fetchOutcome = await fetchRecord(key, runtimeMessenger);
    if (guard.isStale()) return { guard, assessment: null };

    const fetchFailure = describeFetchFailure(fetchOutcome);
    if (fetchFailure) {
      if (fetchFailure.error) logger?.warn?.('record fetch failed:', fetchFailure.error);
      alert(fetchFailure.message);
      return { guard, assessment: null };
    }

    const assessment = assess(fetchOutcome.record);
    if (assessment.kind === 'error' || assessment.kind === 'needs_attention') {
      await openOptionsForRecovery();
      return { guard, assessment: null };
    }
    if (assessment.kind === 'in_progress') {
      alert(
        `PageToLLM: Analysis is currently in progress (status: ${assessment.stage}). Please wait a moment and try again.`,
      );
      return { guard, assessment: null };
    }
    return { guard, assessment };
  }

  return { load, openOptionsForRecovery };
}
