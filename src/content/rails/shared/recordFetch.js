/**
 * Shared record-fetch helpers for content rails.
 *
 * Pure helpers extracted from openInPageRail in rails/in-page/controller.jsx:
 *   - fetchRecord       chrome.runtime.sendMessage wrapper
 *   - findPickedElements querySelector loop
 *   - assessRecordForRail  validates a fetched record for rail display
 *   - createLoadToken   race-condition guard factory
 */

import { MSG } from '../../../shared/runtime/messages.js';
import { PIPELINE_STAGE, PIPELINE_STATUS } from '../../../shared/runtime/contracts.js';
import { browserRuntimeMessenger } from '../../../utils/runtimeMessages.js';

/**
 * Fetch a record from the background via chrome.runtime.sendMessage without
 * collapsing repository misses, protocol failures, and transport failures.
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
 * Maps a non-successful fetch outcome to its user-facing description. The
 * returned error is suitable for diagnostic logging and deliberately omitted
 * for an ordinary repository miss.
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
 * Walk an array of CSS selector strings and return every element found in the
 * document.  Invalid or missing selectors are silently skipped.
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
 * Discriminated result shapes returned by assessRecordForRail.
 *
 *   { kind: 'ready',           record }
 *   { kind: 'error',           record }
 *   { kind: 'needs_attention', record }
 *   { kind: 'in_progress',     stage }
 *   { kind: 'no_selectors',    record }
 */

/**
 * Validate a record fetched for the in-page rail and return a discriminated
 * result that openInPageRail can switch on without any inline null/status
 * checks.
 *
 * @param {object} record
 * @returns {{ kind: string }}
 */
export function assessRecordForRail(record) {
  if (record.status === PIPELINE_STATUS.ERROR || record.status === PIPELINE_STATUS.CANCELLED) {
    return { kind: 'error', record };
  }
  // Parked awaiting a user retry/skip decision. This is deliberately not an
  // in-flight status and never auto-resumes, so it must NOT look like ordinary
  // progress (which would tell the user to "wait"). In-page surfaces are
  // read-only, so the caller routes this to the Options page, the only place
  // the retry/skip resolution lives.
  if (record.status === PIPELINE_STATUS.NEEDS_ATTENTION) {
    return { kind: 'needs_attention', record };
  }
  if (record.status !== PIPELINE_STATUS.DONE) {
    const stage = record.progress?.stage || record.status || PIPELINE_STAGE.QUEUED;
    return { kind: 'in_progress', stage };
  }
  const selectors = Array.isArray(record.selectors) ? record.selectors : [];
  if (selectors.length === 0) {
    return { kind: 'no_selectors', record };
  }
  return { kind: 'ready', record };
}

/**
 * Create a loading-token guard for aborting stale async rail loads.
 *
 * Usage:
 *   const guard = createLoadToken(tokenHolder);
 *   // …await something…
 *   if (guard.isStale()) return;
 *
 * @param {{ current: symbol|null }} tokenHolder  mutable ref shared with callers
 * @returns {{ token: symbol, isStale: function(): boolean }}
 */
export function createLoadToken(tokenHolder) {
  const token = Symbol('rail-loading');
  tokenHolder.current = token;
  return {
    token,
    isStale() {
      return tokenHolder.current !== token;
    },
  };
}
