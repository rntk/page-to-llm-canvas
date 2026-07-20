/**
 * Shared record-fetch helpers for content rails.
 *
 * Pure helpers extracted from openInPageRail in main.jsx:
 *   - fetchRecord       chrome.runtime.sendMessage wrapper
 *   - findPickedElements querySelector loop
 *   - assessRecordForRail  validates a fetched record for rail display
 *   - createLoadToken   race-condition guard factory
 */

import { MSG } from '../../../shared/runtime/messages.js';
import { sendRuntimeMessage } from '../../../utils/runtimeMessages.js';

/**
 * Fetch a record from the background via chrome.runtime.sendMessage.
 * Resolves null on any error (lastError, exception, bad response).
 *
 * @param {string} key
 * @returns {Promise<object|null>}
 */
export async function fetchRecord(key) {
  try {
    const resp = await sendRuntimeMessage({ type: MSG.getRecord, key });
    return resp && resp.ok ? resp.record : null;
  } catch (_) {
    return null;
  }
}

/**
 * Walk an array of CSS selector strings and return every element found in the
 * document.  Invalid or missing selectors are silently skipped.
 *
 * @param {string[]} selectors
 * @returns {Element[]}
 */
export function findPickedElements(selectors) {
  if (!Array.isArray(selectors)) return [];
  const found = [];
  for (const sel of selectors) {
    if (!sel) continue;
    try {
      const el = document.querySelector(sel);
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
 *   { kind: 'not_found' }
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
 * @param {object|null} record
 * @returns {{ kind: string } & object}
 */
export function assessRecordForRail(record) {
  if (!record) {
    return { kind: 'not_found' };
  }
  if (record.status === 'error' || record.status === 'cancelled') {
    return { kind: 'error', record };
  }
  // Parked awaiting a user retry/skip decision. This is deliberately not an
  // in-flight status and never auto-resumes, so it must NOT look like ordinary
  // progress (which would tell the user to "wait"); route it to the canvas where
  // the retry/skip popup lives.
  if (record.status === 'needs_attention') {
    return { kind: 'needs_attention', record };
  }
  if (record.status !== 'done') {
    const stage = record.progress?.stage || record.status || 'queued';
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
 * @returns {{ token: symbol, isStale: () => boolean }}
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
