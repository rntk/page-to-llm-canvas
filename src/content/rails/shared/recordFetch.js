/**
 * Shared record-fetch helpers for content rails: record fetch, picked-element
 * lookup, and record assessment.
 */

import { MSG } from '../../../shared/runtime/messages.js';
import { PIPELINE_STAGE, PIPELINE_STATUS } from '../../../shared/runtime/contracts.js';
import { browserRuntimeMessenger } from '../../../utils/runtimeMessages.js';

/**
 * Fetch a record from the background, keeping repository misses, protocol
 * failures, and transport failures distinct.
 *
 * @param {string} key
 * @param {{ send: function(object): Promise<object|null> }} runtimeMessenger
 * @returns {Promise<
 *   | {kind: 'found', record: object}
 *   | {kind: 'not_found'}
 *   | {kind: 'service_error', error: Error}
 *   | {kind: 'transport_error', error: Error}
 *   | {kind: 'invalid_response', error: Error}
 * >}
 */
export async function fetchRecord(key, runtimeMessenger = browserRuntimeMessenger) {
  try {
    const resp = await runtimeMessenger.send({ type: MSG.getRecordView, key });
    if (resp?.ok === false && !resp.error) return { kind: 'not_found' };
    if (resp?.ok === false && resp?.error === 'record not found') return { kind: 'not_found' };
    if (resp?.ok === false && typeof resp.error === 'string') {
      return { kind: 'service_error', error: new Error(resp.error) };
    }
    if (resp?.pipelineFailure?.message) {
      return { kind: 'service_error', error: new Error(resp.pipelineFailure.message) };
    }
    if (resp?.ok === true && resp.record && typeof resp.record === 'object') {
      return { kind: 'found', record: resp.record };
    }
    return {
      kind: 'invalid_response',
      error: new Error('The record service returned an invalid response.'),
    };
  } catch (error) {
    return {
      kind: 'transport_error',
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

/**
 * Map a non-successful fetch outcome to a user-facing message. `error` is for
 * diagnostic logging and is omitted for an ordinary repository miss.
 * @param {{kind: string, error?: Error}} outcome
 * @returns {{message: string, error?: Error}|null}
 */
export function describeFetchFailure(outcome) {
  switch (outcome.kind) {
    case 'found':
      return null;
    case 'not_found':
      return { message: 'PageToLLM: Analysis record not found.' };
    case 'transport_error':
      return {
        message: 'PageToLLM: Could not load the analysis record. Please try again.',
        error: outcome.error,
      };
    case 'service_error':
      return {
        message: 'PageToLLM: The analysis service could not load this record.',
        error: outcome.error,
      };
    case 'invalid_response':
      return {
        message: 'PageToLLM: The analysis service returned an unexpected response.',
        error: outcome.error,
      };
    default:
      return {
        message: 'PageToLLM: The analysis service returned an unexpected response.',
        error: new Error(`Unknown record fetch outcome: ${String(outcome.kind)}`),
      };
  }
}

/**
 * Return every element found for the CSS selectors; invalid or missing ones are skipped.
 *
 * @param {string[]} selectors
 * @param {Document} contentDocument
 * @returns {Element[]}
 */
export function findPickedElements(selectors, contentDocument = globalThis.document) {
  if (!Array.isArray(selectors)) return [];
  const found = [];
  for (const sel of selectors) {
    if (!sel) continue;
    try {
      const el = contentDocument.querySelector(sel);
      if (el) found.push(el);
    } catch (_) {
      /* invalid selector — skip */
    }
  }
  return found;
}

/**
 * Discriminated result shapes returned by assessRecordLifecycle.
 *
 *   { kind: 'ready',           record }
 *   { kind: 'error',           record }
 *   { kind: 'needs_attention', record }
 *   { kind: 'in_progress',     stage }
 */

/**
 * Classify a fetched record by pipeline lifecycle only: error/cancelled and
 * parked records need user action (routed to Options), in-flight records are
 * worth waiting for, and only `done` records can be displayed. Surface-specific
 * prerequisites are layered on top by the caller.
 *
 * @param {object} record
 * @returns {{ kind: string }}
 */
export function assessRecordLifecycle(record) {
  if (record.status === PIPELINE_STATUS.ERROR || record.status === PIPELINE_STATUS.CANCELLED) {
    return { kind: 'error', record };
  }
  // Parked awaiting a user retry/skip decision; never auto-resumes, so it must
  // not look like progress ("wait"). Retry/skip lives only in Options.
  if (record.status === PIPELINE_STATUS.NEEDS_ATTENTION) {
    return { kind: 'needs_attention', record };
  }
  if (record.status !== PIPELINE_STATUS.DONE) {
    const stage = record.progress?.stage || record.status || PIPELINE_STAGE.QUEUED;
    return { kind: 'in_progress', stage };
  }
  return { kind: 'ready', record };
}

/**
 * Discriminated result shapes returned by assessRecordForRail: every
 * assessRecordLifecycle shape plus the in-page rail's DOM prerequisite.
 *
 *   { kind: 'no_selectors',    record }
 */

/**
 * Assess a record for the in-page rail: lifecycle result, plus `no_selectors`
 * when a ready record has no page selectors.
 *
 * @param {object} record
 * @returns {{ kind: string }}
 */
export function assessRecordForRail(record) {
  const lifecycle = assessRecordLifecycle(record);
  if (lifecycle.kind !== 'ready') return lifecycle;
  const selectors = Array.isArray(record.selectors) ? record.selectors : [];
  if (selectors.length === 0) {
    return { kind: 'no_selectors', record };
  }
  return { kind: 'ready', record };
}
