import { MSG } from '../shared/runtime/messages.js';
import { assertActionResponseSucceeded } from '../shared/runtime/actionResponses.js';
import { sendRuntimeMessage } from './runtimeMessages.js';

/**
 * Utility function to split a pipeline error stack trace or message.
 * Extracts the first line as the clean error message, and the rest as details.
 * Hardened to safely handle non-string values.
 *
 * @param {*} recordError - The raw error value to split.
 * @returns {{ message: string, details: string }}
 */
export function splitError(recordError) {
  const errorStr = recordError == null ? '' : String(recordError);
  if (!errorStr) {
    return { message: '', details: '' };
  }
  const index = errorStr.indexOf('\n');
  if (index === -1) {
    return { message: errorStr, details: '' };
  }
  return {
    message: errorStr.slice(0, index),
    details: errorStr.slice(index + 1),
  };
}

/**
 * Shared helper to send a retryRecord message to the background service worker.
 *
 * @param {string} key - The unique storage key for the record.
 * @param {string} [serviceName] - The name of the calling service (for logs).
 * @returns {Promise<object>}
 */
export async function retryRecord(key, serviceName = 'Canvas') {
  let resp;
  try {
    resp = await sendRuntimeMessage({ type: MSG.retryRecord, key });
  } catch (e) {
    console.warn(`PageToLLM ${serviceName} retry error:`, e.message);
    throw e;
  }
  if (resp?.ok !== true) {
    console.warn(`PageToLLM ${serviceName} retry failed:`, resp?.error);
  }
  return assertActionResponseSucceeded(resp, 'Retry failed');
}

/**
 * Resolves a record parked in `needs_attention`: re-runs the failed summaries
 * ("retry") or accepts them empty and finishes ("skip").
 *
 * A stale response is raised as a distinguishable `StaleActionError`. The
 * shared review overlay renders that condition informationally, while callers
 * that do not own a separate notice still surface useful feedback.
 *
 * @param {string} key - The unique storage key for the record.
 * @param {'retry'|'skip'} action
 * @param {string} [serviceName] - The name of the calling service (for logs).
 * @returns {Promise<object>}
 */
export async function resolveSummaryErrors(key, action, serviceName = 'Canvas') {
  let resp;
  try {
    resp = await sendRuntimeMessage({ type: MSG.resolveSummaryErrors, key, action });
  } catch (e) {
    console.warn(`PageToLLM ${serviceName} resolve error:`, e.message);
    throw e;
  }
  if (resp?.ok !== true) {
    console.warn(`PageToLLM ${serviceName} resolve failed:`, resp?.error);
  }
  return assertActionResponseSucceeded(resp, 'Resolve failed');
}

/**
 * Shared helper to send a reprocessRecord message to the background service
 * worker. Unlike `retryRecord`, this discards the stored checkpoint and rebuilds
 * topics from the saved HTML, which is the only recovery for a record whose
 * checkpoint is too incomplete to resume.
 *
 * @param {string} key - The unique storage key for the record.
 * @param {string} [serviceName] - The name of the calling service (for logs).
 * @returns {Promise<object>}
 */
export async function reprocessRecord(key, serviceName = 'Canvas') {
  let resp;
  try {
    resp = await sendRuntimeMessage({ type: MSG.reprocessRecord, key });
  } catch (e) {
    console.warn(`PageToLLM ${serviceName} reprocess error:`, e.message);
    throw e;
  }
  if (resp?.ok !== true) {
    console.warn(`PageToLLM ${serviceName} reprocess failed:`, resp?.error);
  }
  return assertActionResponseSucceeded(resp, 'Reprocess failed');
}

/**
 * Shared helper to send a generateRecordSummaries message to the background
 * service worker: fills in the summaries a finished record is still missing,
 * reusing the stored topics instead of reprocessing the page.
 *
 * @param {string} key - The unique storage key for the record.
 * @param {string} [serviceName] - The name of the calling service (for logs).
 * @returns {Promise<object>}
 */
export async function generateRecordSummaries(key, serviceName = 'Canvas') {
  let resp;
  try {
    resp = await sendRuntimeMessage({ type: MSG.generateRecordSummaries, key });
  } catch (e) {
    console.warn(`PageToLLM ${serviceName} generate summaries error:`, e.message);
    throw e;
  }
  if (resp?.ok !== true) {
    console.warn(`PageToLLM ${serviceName} generate summaries failed:`, resp?.error);
  }
  return assertActionResponseSucceeded(resp, 'Generate summaries failed');
}
