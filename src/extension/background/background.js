import {
  readRecord,
  writeRecord,
  updateRecord,
  listRecords,
  deleteRecord,
  deleteAll,
  findRecordByUrl,
  reconcileRecordStorage,
} from '../../../worker/storage/storage.js';
import {
  listChats,
  readChat,
  appendChatTurn,
  deleteChatHistory,
  reconcileChatStorage,
} from '../../../worker/storage/chatStorage.js';
import {
  isSummaryCheckpointComplete,
  isSummaryCheckpointRevisionCurrent,
  runPipeline,
} from '../../../worker/pipeline/orchestrator.js';
import { formatPipelineError } from '../../../worker/pipeline/pipelineRuntime.js';
import { callLLMDirect } from '../../../worker/llm/llm.js';
import { clearLlmMetrics, recordLlmMetric } from '../../../worker/metrics/llm.js';
import { clearChatToolMetrics, recordChatToolMetric } from '../../../worker/metrics/chatTool.js';
import { clearParserMetrics } from '../../../worker/metrics/parser.js';
import { clearResplitMetrics } from '../../../worker/metrics/resplit.js';
import {
  clearAllExtensionData,
  getStorageOverview,
} from '../../../worker/storage/dataManagement.js';
import { getStoredSummariesDisabled } from '../../../worker/settings/summary.js';
import {
  getProvidersState,
  sanitizeProvider,
  sanitizeProvidersState,
  saveProvider,
  deleteProvider,
  setActiveProvider,
} from '../../../worker/llm/providers.js';
import {
  refreshActionProgressIcon,
  scheduleActionProgressIconRefresh,
} from '../../../worker/actionIcon.js';
import { isInFlightRecord, isInFlightStatus } from '../../../worker/pipeline/pipelineStatus.js';
import {
  acceptFailedSummaryRun,
  migrateLegacySummaryRunMarkers,
} from '../../../worker/pipeline/summaryRunMarkers.js';
import { MSG } from '../../shared/runtime/messages.js';
import {
  createQueuedRecord,
  IN_FLIGHT_PIPELINE_STATUSES,
  isImportableRecord,
  PIPELINE_STAGE,
  PIPELINE_STATUS,
  SUMMARY_GENERATION_SOURCE_STATUSES,
} from '../../shared/runtime/contracts.js';
import { createLogger } from '../../shared/runtime/log.js';

const log = createLogger();
const keepaliveLog = createLogger('keepalive');
const backgroundLog = createLogger('background');
const resumeLog = createLogger('resume');

const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
const RECORD_STORAGE_PREFIX = 'pagetollm:rec:';
/**
 * One turn can fan out into several provider requests. This registry is
 * deliberately best-effort: MV3 worker termination drops both these
 * controllers and the fetches they own, so there is no resumable request state
 * to persist for a later cancel message.
 */
const activeChatRequests = new Map();
const activeChatCompletionJobs = new Set();

function registerChatRequest(turnId, controller) {
  if (!turnId) return;
  const controllers = activeChatRequests.get(turnId) || new Set();
  controllers.add(controller);
  activeChatRequests.set(turnId, controllers);
}

function unregisterChatRequest(turnId, controller) {
  if (!turnId) return;
  const controllers = activeChatRequests.get(turnId);
  if (!controllers) return;
  controllers.delete(controller);
  if (controllers.size === 0) activeChatRequests.delete(turnId);
}

function isSafeChatId(chatId) {
  return typeof chatId === 'string' && !!chatId && !chatId.includes(':');
}

function isExtensionPageSender(sender) {
  const extensionRoot =
    typeof chrome.runtime.getURL === 'function' ? chrome.runtime.getURL('') : '';
  return !!sender?.url && !!extensionRoot && sender.url.startsWith(extensionRoot);
}

// Alarm name used to keep the service worker alive while pipelines are running.
const KEEPALIVE_ALARM = 'pipeline-keepalive';
// Chrome MV3 enforces a minimum of 30 s (0.5 min) for alarm periods.
const KEEPALIVE_PERIOD_MINUTES = 0.5;

/**
 * Returns a copy of the topic-summaries map with in-flight error markers
 * replaced by per-run `acceptedFailure: true` markers, so successful sibling
 * runs remain reusable while only the explicitly failed runs are accepted as-is
 * on the next resume. Legacy topic-level markers are migrated conservatively.
 *
 * @param {Record<string, object>} topicSummaries
 * @returns {Record<string, object>}
 */
export function clearSummaryErrorFlags(topicSummaries) {
  const src = topicSummaries && typeof topicSummaries === 'object' ? topicSummaries : {};
  const out = {};
  for (const [name, s] of Object.entries(src)) {
    if (s && typeof s === 'object') {
      const { error, error_kind, error_message, error_detail, ...rest } = s;
      // Replace the stripped flags with the transient `acceptedFailure` marker:
      // the resumed run must still recognize the leaf as failed (so ancestor
      // summaries skip its source and finalization stamps `forcedEmpty`), while
      // `planSummaryWork` deliberately ignores the marker and reuses the leaf
      // as-is — no re-query, which is the whole point of "skip".
      const hadError = error || error_kind || error_message || error_detail;
      if (Array.isArray(rest.runs)) {
        const migrated = migrateLegacySummaryRunMarkers({
          ...rest,
          ...(hadError ? { error: true } : {}),
        });
        const runs = migrated.runs.map(acceptFailedSummaryRun);
        const acceptedRun = runs.some((run) => run?.acceptedFailure === true);
        out[name] = {
          ...rest,
          runs,
          ...(acceptedRun ? { acceptedFailure: true } : {}),
        };
      } else {
        // Legacy/imported entries may predate the per-run `runs` shape.
        out[name] = hadError ? { ...rest, acceptedFailure: true } : rest;
      }
    } else {
      out[name] = s;
    }
  }
  return out;
}

/**
 * Finds merge-only failures in a parked record. Leaf failures live on
 * `topic_summaries` with `error: true`; a parked error without that marker was
 * raised while resolving an internal tree node. On "skip" we preserve those
 * paths as a transient directive so the resumed run can finalize their empty
 * result without sending the same source-summary request again.
 *
 * @param {object[]} summaryErrors
 * @param {Record<string, object>} topicSummaries
 * @returns {string[]}
 */
export function getAcceptedMergeFailurePaths(summaryErrors, topicSummaries) {
  const summaries = topicSummaries && typeof topicSummaries === 'object' ? topicSummaries : {};
  const paths = new Set();
  for (const error of Array.isArray(summaryErrors) ? summaryErrors : []) {
    const path = error && typeof error.topic === 'string' ? error.topic : '';
    if (path && !summaries[path]?.error) paths.add(path);
  }
  return [...paths];
}

// Tracks the last `alarms.create` attempt: `create` replaces an existing
// alarm and restarts its period, so repeated creates would keep pushing the
// keepalive's fire time out.
let lastKeepAliveCreateAt = 0;

function scheduleKeepAlive() {
  chrome.alarms.get(KEEPALIVE_ALARM, (existing) => {
    // lastError persists for the whole callback, so a successful create below
    // wouldn't clear a get failure; compare by identity against createError.
    const getError = chrome.runtime.lastError;
    const getFailed = !!getError;
    if (getFailed) {
      // `existing` can't be trusted after a failed get, but bailing out here
      // would guarantee no alarm exists, so retry `create` below instead.
      // Skip it if already created this period, or the alarm would never fire.
      log.warn('chrome.alarms.get failed:', getError);
      if (Date.now() - lastKeepAliveCreateAt < KEEPALIVE_PERIOD_MINUTES * 60_000) return;
    }
    if (getFailed || !existing) {
      // Only a successful create may stamp the throttle — a failed create
      // leaves no alarm to protect, so suppressing the next attempt would
      // strand the keepalive. Stamped optimistically below; released if it rejects.
      try {
        const created = chrome.alarms.create(KEEPALIVE_ALARM, {
          periodInMinutes: KEEPALIVE_PERIOD_MINUTES,
        });
        if (created && typeof created.then === 'function') {
          const stampedAt = Date.now();
          lastKeepAliveCreateAt = stampedAt;
          created.catch((err) => {
            // Clear only our own stamp: a rejection landing after a later
            // create succeeded must not clear that stamp and reopen the loop.
            if (lastKeepAliveCreateAt === stampedAt) lastKeepAliveCreateAt = 0;
            log.warn('chrome.alarms.create failed:', err);
          });
        } else {
          const createError = chrome.runtime.lastError;
          if (createError && createError !== getError) {
            log.warn('chrome.alarms.create failed:', createError);
          } else if (!getFailed) {
            // Only stamp when the get itself succeeded — after a failed get,
            // this lastError may just be that same stale error.
            lastKeepAliveCreateAt = Date.now();
          }
        }
      } catch (err) {
        log.warn('chrome.alarms.create failed:', err);
      }
    }
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  // Resume any in-flight records that lost their SW context (e.g. after SW termination).
  listRecords()
    .then((items) => {
      const inFlight = items.filter(isInFlightRecord);
      if (inFlight.length === 0) {
        chrome.alarms.clear(KEEPALIVE_ALARM);
        return;
      }
      for (const rec of inFlight) {
        startPipeline(rec.key).catch((err) => {
          keepaliveLog.error('resume failed for', rec.key, err);
        });
      }
    })
    .catch((err) => {
      keepaliveLog.error('listRecords failed:', err);
    });
});

try {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (Object.keys(changes).some((key) => key.startsWith(RECORD_STORAGE_PREFIX))) {
      scheduleActionProgressIconRefresh();
    }
  });
} catch (_) {
  /* noop */
}

/**
 * In-memory job registry to prevent duplicate pipeline runs while the
 * service worker is alive. Keyed by record key; value is the run promise.
 * @type {Map<string, {promise: Promise<void>, controller: AbortController, pipelineRunId: string}>}
 */
const _jobRegistry = new Map();
const _starting = new Set();

/** Clears the in-memory job registry. Exposed for testing only. */
export function _resetJobRegistry() {
  for (const job of _jobRegistry.values()) {
    job.controller.abort();
  }
  _jobRegistry.clear();
  _starting.clear();
}

function createPipelineRunId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function cancelActivePipeline(key, options = {}) {
  const job = _jobRegistry.get(key);
  if (!job) return false;
  // A handler that read an earlier snapshot must not abort a job subsequently
  // started by the writer that won ownership of this record. Property presence
  // deliberately distinguishes an unguarded cancel from a legacy record whose
  // expected run id is explicitly `undefined`.
  if (
    Object.hasOwn(options, 'expectedPipelineRunId') &&
    job.pipelineRunId !== options.expectedPipelineRunId
  ) {
    return false;
  }
  job.controller.abort();
  _jobRegistry.delete(key);
  // Intentionally do NOT clear the keepalive alarm here: the in-memory registry
  // is not the source of truth for whether work remains. A record can still be
  // in an in-flight status in storage (e.g. an aborted run that left its status
  // untouched). The onAlarm handler is the only place allowed to clear the
  // alarm, and it does so from storage after confirming nothing is in-flight.
  return true;
}

/**
 * @param {object} rec
 * @returns {boolean}
 */
function isStaleRecord(rec) {
  if (!rec) return false;
  if (!isInFlightStatus(rec.status)) return false;
  const age = Date.now() - (rec.updatedAt || 0);
  return age > STALE_THRESHOLD_MS;
}

/**
 * @param {string} s
 * @returns {Promise<string>}
 */
async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  const bytes = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * Starts the pipeline for a key if it is not already running.
 * Resumes stale or orphaned in-flight records (e.g. after a SW restart).
 * If a job is already in the registry but the record is stale (updatedAt older
 * than STALE_THRESHOLD_MS), the hung promise is evicted and the job is restarted.
 *
 * @param {string} key
 * @returns {Promise<void>}
 */
export async function startPipeline(key) {
  if (_starting.has(key)) return;

  _starting.add(key);
  try {
    // Arm the recovery alarm before the first storage read, not after it.
    // Callers persist an in-flight status and answer `{ok: true}` before this
    // runs (submit, retry, reprocess, Generate summaries, Retry/Skip), so a
    // failing read here would otherwise leave the record in-flight with no job,
    // no alarm and nothing left to resume it — the UI would wait forever. The
    // onAlarm handler clears the alarm as soon as storage says nothing is
    // in-flight, so arming it for a record that turns out not to need it costs
    // a single alarm tick.
    scheduleKeepAlive();

    const rec = await readRecord(key);
    if (!rec) return;

    if (!isInFlightStatus(rec.status)) return;

    // Skip if a healthy (non-stale) job is already in the registry.
    if (_jobRegistry.has(key) && !isStaleRecord(rec)) return;

    // Taking a record over from a hung job needs a new run id, and needs it
    // before that job is aborted. Aborting is a request, not synchronous
    // ownership: the evicted run can still be parked inside a provider call and
    // settle afterwards. Since the orchestrator deliberately no longer launders
    // a post-abort provider failure into a cancellation, that late failure
    // persists ERROR guarded only by the run-id CAS — so sharing the record's
    // current id would give it a passing CAS against work this takeover has
    // since finished, flipping a DONE record back to ERROR. Rotating first
    // makes every write from the evicted run fail that CAS instead, which the
    // orchestrator already treats as a superseded run.
    let pipelineRunId = rec.pipelineRunId;
    if (_jobRegistry.has(key)) {
      const rotatedRunId = createPipelineRunId();
      const rotated = await updateRecord(
        key,
        { pipelineRunId: rotatedRunId },
        { expectedPipelineRunId: rec.pipelineRunId },
      );
      // Rejected CAS: another writer (a retry/reprocess minting its own id, or
      // a deletion) took ownership between the read and here. It cancels and
      // restarts the record itself, so leave the current job alone rather than
      // aborting a run this call no longer owns.
      if (!rotated) return;
      pipelineRunId = rotatedRunId;
    }

    // Evict and abort any hung/stale promise before starting fresh.
    cancelActivePipeline(key);

    const controller = new AbortController();
    const promise = runPipeline(key, {
      pipelineRunId,
      signal: controller.signal,
    })
      .catch((err) => {
        backgroundLog.error('pipeline failed for', key, err);
        // Defensive fallback: the pipeline's own attempt to persist an ERROR
        // status on failure (orchestrator.js) can itself fail to write, in
        // which case the record would keep an in-flight status forever and
        // the keepalive alarm would re-run this failing pipeline every 30s.
        // Best-effort re-attempt here; if this also fails there's nothing
        // further we can safely do without risking a retry loop of writes.
        // `expectedPipelineRunId` mirrors runtime.update (pipelineRuntime.js)
        // so a superseded run's fallback can never clobber a newer run that
        // has since taken ownership of this record — the same run-id guard
        // orchestrator.js relies on for its own AbortError handling.
        return updateRecord(
          key,
          { status: PIPELINE_STATUS.ERROR, error: formatPipelineError(err) },
          { expectedPipelineRunId: pipelineRunId },
        )
          .then((updated) => {
            if (!updated) {
              // Guard rejected the write (record no longer owned by this run,
              // or already gone): someone else owns the record now, so no
              // fallback is needed. Not an error.
              log.warn('fallback error-status write skipped (record superseded) for', key);
            }
          })
          .catch((fallbackErr) => {
            log.error('fallback error-status write also failed for', key, fallbackErr);
          });
      })
      .finally(() => {
        const current = _jobRegistry.get(key);
        if (current?.promise === promise) {
          _jobRegistry.delete(key);
        }
        // Do not clear the keepalive alarm from here. If this run finished by
        // being aborted, the record may still be in an in-flight status in
        // storage; clearing the alarm would orphan it with nothing left to
        // resume it. The onAlarm handler clears the alarm from storage truth.
      });

    _jobRegistry.set(key, { promise, controller, pipelineRunId });
    return promise;
  } finally {
    _starting.delete(key);
  }
}

/**
 * @param {object} submission
 * @param {string} [submission.html]
 * @param {string} [submission.sourceUrl]
 * @param {string[]} [submission.selectors]
 * @returns {Promise<{ok: boolean, key: string, error: string}>}
 */
export async function handleSubmit(submission) {
  const { html, sourceUrl, selectors } = submission;
  if (!html) return { ok: false, error: 'missing html' };

  let existing = null;
  if (sourceUrl) {
    existing = await findRecordByUrl(sourceUrl);
  }

  let key;
  if (existing) {
    key = existing.key;
  } else {
    const hex = await sha256Hex(html);
    key = hex.slice(0, 32);
    existing = await readRecord(key);
  }

  if (existing && existing.status === PIPELINE_STATUS.DONE) {
    return { ok: true, key };
  }

  // If a job is already running (or starting) for this key, do not clobber it.
  if (_jobRegistry.has(key) || _starting.has(key)) {
    return { ok: true, key };
  }

  const now = Date.now();
  const pipelineRunId = createPipelineRunId();
  // Whether this run generates summaries is decided here, at kickoff, from the
  // global toggle, and persisted on the record as a run directive. The
  // orchestrator only ever reads the record, so the decision survives mid-run
  // toggle flips and service-worker restarts (see runPipeline).
  const skipSummaries = await getStoredSummariesDisabled();
  const rec =
    existing ||
    createQueuedRecord({
      key,
      sourceUrl: sourceUrl || '',
      html,
      selectors,
      pipelineRunId,
      skipSummaries,
      now,
    });
  if (existing) {
    rec.pipelineRunId = pipelineRunId;
    rec.status = PIPELINE_STATUS.PENDING;
    rec.error = null;
    rec.progress = { stage: PIPELINE_STAGE.QUEUED, done: 0, total: 0 };
    rec.updatedAt = now;
    rec.sourceUrl = sourceUrl || rec.sourceUrl;
    rec.html = html;
    rec.processingLog = [];
    rec.skipSummaries = skipSummaries;
    // A submission for a non-terminal URL replaces its HTML and therefore
    // invalidates every checkpoint derived from the previous content. Keep
    // this in sync with reprocessRecord: retry may otherwise mistake the old
    // topics/sentences for a checkpoint belonging to this new revision.
    rec.topics = [];
    rec.topic_summaries = {};
    rec.topic_summary_index = {};
    rec.source_summary_units = {};
    rec.sentences = [];
    rec.text = '';
    rec.summaryErrors = [];
    rec.forceFinalize = false;
    rec.acceptedMergeFailurePaths = [];
    rec.summaryCheckpointContentRevision = null;
    rec.summaryCheckpointPreferContentLanguage = null;
    rec.summariesIncomplete = false;
    if (Array.isArray(selectors)) rec.selectors = selectors;
  }
  await writeRecord(rec, { bumpContentRevision: !!existing });

  // Start the pipeline in the background; do not await.
  startPipeline(key).catch((err) => {
    backgroundLog.error('startPipeline failed:', err);
  });

  return { ok: true, key };
}

/**
 * Declarative handler registry.
 *
 * Each entry has:
 *   requiresExtensionPage {boolean}  – when true, sender must be an extension page
 *   validate(msg) {function}         – returns an error string or null
 *   handle(msg, sender) {function}   – async, returns the response fields object
 *
 * @type {Record<string, {
 *   requiresExtensionPage: boolean,
 *   validate: function(object): (string|null),
 *   handle: function(object, object): Promise<object>
 * }>}
 */
export const MESSAGE_HANDLERS = {
  [MSG.submit]: {
    requiresExtensionPage: false,
    validate: () => null,
    async handle(msg) {
      return handleSubmit(msg);
    },
  },

  [MSG.ensurePipeline]: {
    requiresExtensionPage: false,
    validate(msg) {
      return msg.key ? null : 'missing key';
    },
    async handle(msg) {
      await startPipeline(msg.key);
      return { ok: true };
    },
  },

  [MSG.retryRecord]: {
    requiresExtensionPage: false,
    validate(msg) {
      return msg.key ? null : 'missing key';
    },
    async handle(msg) {
      const rec = await readRecord(msg.key);
      if (!rec) {
        return { ok: false, error: 'record not found' };
      }
      // A generic failure can happen after the topic checkpoint and one or
      // more summaries have already been persisted (for example, a later
      // storage write). Re-enter the summarizing status only when the whole
      // checkpoint is safe to resume; otherwise retain the normal fresh-run
      // retry path. Reprocess remains the explicitly destructive operation.
      const resumesSummaries =
        isSummaryCheckpointRevisionCurrent(rec) && isSummaryCheckpointComplete(rec);
      // A Retry can be pressed after a generic failure interrupted a prior
      // Skip/force-finalize resume. Those directives are part of the saved
      // summary checkpoint: dropping them would re-run merge work the user
      // explicitly accepted, and would stop accepted leaf failures from being
      // finalized as retryable empties. They have no meaning on a fresh run.
      const forceFinalize = resumesSummaries && rec.forceFinalize === true;
      const acceptedMergeFailurePaths =
        forceFinalize && Array.isArray(rec.acceptedMergeFailurePaths)
          ? rec.acceptedMergeFailurePaths
          : [];
      const updated = await updateRecord(
        msg.key,
        {
          pipelineRunId: createPipelineRunId(),
          status: resumesSummaries ? PIPELINE_STATUS.SUMMARIZING : PIPELINE_STATUS.PENDING,
          error: null,
          progress: {
            stage: resumesSummaries ? PIPELINE_STAGE.SUMMARIZING_TOPICS : PIPELINE_STAGE.QUEUED,
            done: 0,
            total: resumesSummaries ? rec.topics.length : 0,
          },
          // A resumed checkpoint must finish the summary work that was
          // already paid for. Applying a newly enabled global "skip
          // summaries" preference here would finalize it by clearing those
          // saved summaries. Fresh retries retain the directive chosen when
          // the failed run was submitted; only legacy records without one
          // fall back to the current global setting.
          skipSummaries: resumesSummaries
            ? false
            : typeof rec.skipSummaries === 'boolean'
              ? rec.skipSummaries
              : await getStoredSummariesDisabled(),
          forceFinalize,
          acceptedMergeFailurePaths,
          summariesIncomplete: false,
        },
        { expectedPipelineRunId: rec.pipelineRunId },
      );
      if (!updated) {
        return { ok: true, stale: true };
      }
      // Abort only the run represented by the snapshot that this successful
      // compare-and-swap superseded.
      cancelActivePipeline(msg.key, { expectedPipelineRunId: rec.pipelineRunId });
      startPipeline(msg.key).catch((err) => {
        log.child('retryRecord startPipeline').error('failed:', err);
      });
      return { ok: true };
    },
  },

  [MSG.reprocessRecord]: {
    requiresExtensionPage: false,
    validate(msg) {
      return msg.key ? null : 'missing key';
    },
    async handle(msg) {
      const rec = await readRecord(msg.key);
      if (!rec) {
        return { ok: false, error: 'record not found' };
      }
      const updated = await updateRecord(
        msg.key,
        {
          pipelineRunId: createPipelineRunId(),
          status: PIPELINE_STATUS.PENDING,
          error: null,
          progress: { stage: PIPELINE_STAGE.QUEUED, done: 0, total: 0 },
          topics: [],
          topic_summaries: {},
          topic_summary_index: {},
          source_summary_units: {},
          sentences: [],
          text: '',
          processingLog: [],
          skipSummaries: await getStoredSummariesDisabled(),
          summaryErrors: [],
          forceFinalize: false,
          acceptedMergeFailurePaths: [],
          summaryCheckpointContentRevision: null,
          summaryCheckpointPreferContentLanguage: null,
          summariesIncomplete: false,
        },
        {
          bumpContentRevision: true,
          expectedPipelineRunId: rec.pipelineRunId,
        },
      );
      if (!updated) {
        return { ok: true, stale: true };
      }
      // Abort only after winning the CAS, and only abort the run represented
      // by the snapshot that was just superseded.
      cancelActivePipeline(msg.key, { expectedPipelineRunId: rec.pipelineRunId });
      startPipeline(msg.key).catch((err) => {
        log.child('reprocessRecord startPipeline').error('failed:', err);
      });
      return { ok: true };
    },
  },

  // Generates (or completes) summaries for an already-processed record without
  // redoing the clean/split/topic-ranges stages. Not a new pipeline mode: the
  // record is put back into the 'summarizing' stage with an explicit
  // "summaries on" run directive, and the orchestrator's existing resume path
  // reuses the stored topics/sentences, keeps summaries that already succeeded,
  // and only queries the LLM for the ones still missing or failed.
  [MSG.generateRecordSummaries]: {
    requiresExtensionPage: false,
    validate(msg) {
      return msg.key ? null : 'missing key';
    },
    async handle(msg) {
      const rec = await readRecord(msg.key);
      if (!rec) {
        return { ok: false, error: 'record not found' };
      }
      // This action resumes a terminal record's saved checkpoint. It must not
      // replace an active pipeline (which could still be building that
      // checkpoint) with a summaries-only run.
      if (!SUMMARY_GENERATION_SOURCE_STATUSES.has(rec.status)) {
        return { ok: true, stale: true };
      }
      // The resume path needs a complete topic/sentence checkpoint. Reject
      // before changing status or cancelling work: malformed imports can have
      // non-empty arrays whose topic references still cannot be summarized.
      if (!isSummaryCheckpointComplete(rec)) {
        const hasTopicData = Array.isArray(rec.topics) && rec.topics.length > 0;
        const error = hasTopicData
          ? 'record has an incomplete summary checkpoint — reprocess it instead'
          : 'record has no topics yet — reprocess it instead';
        return { ok: false, error };
      }
      if (!isSummaryCheckpointRevisionCurrent(rec)) {
        return {
          ok: false,
          error: 'record summary checkpoint is stale — reprocess it instead',
        };
      }
      const updated = await updateRecord(
        msg.key,
        {
          pipelineRunId: createPipelineRunId(),
          status: PIPELINE_STATUS.SUMMARIZING,
          error: null,
          // Explicit intent: this run generates summaries even while the global
          // "disable summaries" toggle is on.
          skipSummaries: false,
          summaryErrors: [],
          forceFinalize: false,
          acceptedMergeFailurePaths: [],
          summariesIncomplete: false,
          progress: { stage: PIPELINE_STAGE.SUMMARIZING_TOPICS, done: 0, total: rec.topics.length },
        },
        {
          expectedPipelineRunId: rec.pipelineRunId,
          expectedStatuses: [...SUMMARY_GENERATION_SOURCE_STATUSES],
        },
      );
      if (!updated) {
        return { ok: true, stale: true };
      }
      cancelActivePipeline(msg.key, { expectedPipelineRunId: rec.pipelineRunId });
      startPipeline(msg.key).catch((err) => {
        log.child('generateRecordSummaries startPipeline').error('failed:', err);
      });
      return { ok: true };
    },
  },

  [MSG.cancelRecordProcessing]: {
    requiresExtensionPage: false,
    validate(msg) {
      return msg.key ? null : 'missing key';
    },
    async handle(msg) {
      const rec = await readRecord(msg.key);
      if (!rec) {
        return { ok: false, error: 'record not found' };
      }
      if (!isInFlightStatus(rec.status)) {
        return { ok: true, stale: true };
      }
      const updated = await updateRecord(
        msg.key,
        {
          pipelineRunId: createPipelineRunId(),
          status: PIPELINE_STATUS.CANCELLED,
          error: 'Processing stopped.',
          summariesIncomplete: false,
          progress: { stage: PIPELINE_STAGE.CANCELLED, done: 0, total: 0 },
        },
        {
          expectedPipelineRunId: rec.pipelineRunId,
          // A finalizer keeps the same run id, so the queued write must also
          // verify that this record has not already reached a terminal state.
          expectedStatuses: [...IN_FLIGHT_PIPELINE_STATUSES],
        },
      );
      if (!updated) {
        return { ok: true, stale: true };
      }
      cancelActivePipeline(msg.key, { expectedPipelineRunId: rec.pipelineRunId });
      return { ok: true };
    },
  },

  [MSG.resolveSummaryErrors]: {
    requiresExtensionPage: false,
    validate(msg) {
      if (!msg.key) return 'missing key';
      if (msg.action !== 'retry' && msg.action !== 'skip') return 'invalid action';
      return null;
    },
    async handle(msg) {
      const rec = await readRecord(msg.key);
      if (!rec) {
        return { ok: false, error: 'record not found' };
      }
      // Only a parked record can be resolved; ignore stale/double clicks.
      if (rec.status !== PIPELINE_STATUS.NEEDS_ATTENTION) {
        return { ok: true, stale: true };
      }
      // Imported records can retain a parked status while lacking the sentence
      // checkpoint their topics reference. Reject before changing status,
      // markers, or summaries; only an explicit Reprocess may discard that
      // partial checkpoint and rebuild topics from HTML.
      if (!isSummaryCheckpointComplete(rec)) {
        return {
          ok: false,
          error: 'The saved summary checkpoint is incomplete. Reprocess the record instead.',
        };
      }
      if (!isSummaryCheckpointRevisionCurrent(rec)) {
        return {
          ok: false,
          error: 'The saved summary checkpoint is stale. Reprocess the record instead.',
        };
      }

      const carriedAcceptedMergePaths = Array.isArray(rec.acceptedMergeFailurePaths)
        ? rec.acceptedMergeFailurePaths
        : [];
      const hasAcceptedLeafFailure = Object.values(
        rec.topic_summaries && typeof rec.topic_summaries === 'object' ? rec.topic_summaries : {},
      ).some((summary) => summary?.acceptedFailure === true);
      const patch = {
        pipelineRunId: createPipelineRunId(),
        status: PIPELINE_STATUS.SUMMARIZING,
        error: null,
        summaryErrors: [],
        // A new review can happen while finalizing an earlier Skip. Keep that
        // earlier, path-scoped acceptance active while retrying only the newly
        // failed work.
        forceFinalize:
          msg.action === 'skip' || hasAcceptedLeafFailure || carriedAcceptedMergePaths.length > 0,
        acceptedMergeFailurePaths: carriedAcceptedMergePaths,
        summariesIncomplete: false,
        // Reset the parked progress stage so the resuming UI shows summarizing,
        // not the transient 'needs_attention' stage, before the worker's first write.
        progress: { stage: PIPELINE_STAGE.SUMMARIZING_TOPICS, done: 0, total: 0 },
      };
      if (msg.action === 'skip') {
        // Accept the empty summaries: drop the in-flight error flags so the
        // resumed run reuses the failed leaves as-is (no re-query), and let
        // forceFinalize finalize only those explicitly accepted failures.
        patch.topic_summaries = clearSummaryErrorFlags(rec.topic_summaries);
        patch.acceptedMergeFailurePaths = [
          ...new Set([
            ...carriedAcceptedMergePaths,
            ...getAcceptedMergeFailurePaths(rec.summaryErrors, rec.topic_summaries),
          ]),
        ];
      } else if (carriedAcceptedMergePaths.length > 0) {
        // The parked index contains empty runs for the newly failed merge
        // paths as well as the paths accepted in an earlier review. Reusing it
        // wholesale would turn this explicit Retry into a silent Skip. Force a
        // fresh tree merge; makeForceFinalizeSummarizer still suppresses only
        // the carried, explicitly accepted paths.
        patch.topic_summary_index = {};
      }
      const updated = await updateRecord(msg.key, patch, {
        // The handler derived the entire patch from this snapshot. Serialize
        // competing Retry/Skip decisions by accepting only the first writer;
        // its newly minted run id makes every stale sibling decision fail the
        // compare-and-swap inside storage's per-record update queue.
        expectedPipelineRunId: rec.pipelineRunId,
      });
      if (!updated) {
        return { ok: true, stale: true };
      }
      // Only the winning decision may abort/start jobs. A stale competing
      // overlay must not cancel the pipeline that the winner just launched.
      cancelActivePipeline(msg.key, { expectedPipelineRunId: rec.pipelineRunId });
      startPipeline(msg.key).catch((err) => {
        log.child('resolveSummaryErrors startPipeline').error('failed:', err);
      });
      return { ok: true };
    },
  },

  [MSG.getRecord]: {
    requiresExtensionPage: false,
    validate: () => null,
    async handle(msg) {
      const rec = await readRecord(msg.key);
      if (rec) return { ok: true, record: rec };
      return { ok: false };
    },
  },

  [MSG.listRecords]: {
    requiresExtensionPage: false,
    validate: () => null,
    async handle() {
      const items = await listRecords();
      return { ok: true, items };
    },
  },

  [MSG.importRecords]: {
    requiresExtensionPage: true,
    validate: () => null,
    async handle(msg) {
      const records = Array.isArray(msg.records) ? msg.records : [];
      if (records.length === 0) return { ok: false, error: 'no records to import' };

      let count = 0;
      const recordsByKey = new Map();
      for (const record of records) {
        if (!isImportableRecord(record)) continue;
        recordsByKey.set(record.key.trim(), record);
      }

      for (const record of recordsByKey.values()) {
        const key = record.key.trim();
        const status = isInFlightStatus(record.status)
          ? PIPELINE_STATUS.DONE
          : record.status || PIPELINE_STATUS.DONE;
        cancelActivePipeline(key);
        await writeRecord(
          {
            ...record,
            key,
            pipelineRunId: createPipelineRunId(),
            status,
            error: status === PIPELINE_STATUS.DONE ? null : record.error || null,
            progress: {
              ...(record.progress && typeof record.progress === 'object' ? record.progress : {}),
              stage: PIPELINE_STAGE.IMPORTED,
              done: 1,
              total: 1,
            },
          },
          { bumpContentRevision: true },
        );
        count += 1;
      }

      if (count === 0) return { ok: false, error: 'no valid records to import' };
      return { ok: true, count };
    },
  },

  [MSG.deleteRecord]: {
    requiresExtensionPage: false,
    validate: () => null,
    async handle(msg) {
      cancelActivePipeline(msg.key);
      await deleteRecord(msg.key);
      return { ok: true };
    },
  },

  [MSG.deleteAll]: {
    requiresExtensionPage: false,
    validate: () => null,
    async handle() {
      for (const key of Array.from(_jobRegistry.keys())) {
        cancelActivePipeline(key);
      }
      await deleteAll();
      return { ok: true };
    },
  },

  [MSG.getStorageOverview]: {
    requiresExtensionPage: true,
    validate: () => null,
    async handle() {
      return { ok: true, overview: await getStorageOverview() };
    },
  },

  [MSG.deleteAllExtensionData]: {
    requiresExtensionPage: true,
    validate: () => null,
    async handle() {
      const pipelineJobs = Array.from(_jobRegistry.values(), (job) => job.promise);
      for (const key of Array.from(_jobRegistry.keys())) cancelActivePipeline(key);
      for (const controllers of activeChatRequests.values()) {
        for (const controller of controllers) controller.abort();
      }
      activeChatRequests.clear();

      // Let cancelled work reach its terminal metric/log writes, then drain
      // each metrics queue before the authoritative storage clear. This keeps
      // an old request from restoring data immediately after reset returns.
      await Promise.allSettled([...pipelineJobs, ...activeChatCompletionJobs]);
      // Metric clears are queued after the cancelled work's terminal writes.
      // Let every queue settle even when a best-effort preliminary clear
      // fails, then perform the authoritative full reset. Otherwise one
      // failed metric write would leave all extension data in place.
      await Promise.allSettled([
        clearLlmMetrics(),
        clearParserMetrics(),
        clearResplitMetrics(),
        clearChatToolMetrics(),
      ]);
      await clearAllExtensionData();
      return { ok: true };
    },
  },

  [MSG.llmChatCompletion]: {
    requiresExtensionPage: false,
    validate: () => null,
    async handle(msg) {
      const completionJob = (async () => {
        const {
          prompt = '',
          messages,
          tools,
          toolChoice,
          parallelToolCalls,
          temperature = 0.8,
          taskType,
          chatTurnId,
        } = msg;
        if (!prompt && (!Array.isArray(messages) || messages.length === 0)) {
          return { ok: false, error: 'missing prompt or messages' };
        }
        // Record duration/token/cache metrics for chat calls. The orchestrator path
        // is wrapped separately (wrapCallLLMWithRetry); callLLMDirect itself stays
        // unmetered so pipeline calls are not double-counted here.
        const startedAt = Date.now();
        let sample;
        const controller = chatTurnId ? new AbortController() : null;
        registerChatRequest(chatTurnId, controller);
        let result;
        try {
          result = await callLLMDirect({
            prompt,
            messages,
            tools,
            toolChoice,
            parallelToolCalls,
            temperature,
            signal: controller?.signal,
            metricsCollector: (collected) => {
              if (collected && typeof collected === 'object') sample = collected;
            },
          });
        } finally {
          unregisterChatRequest(chatTurnId, controller);
        }
        // Await (unlike the orchestrator's fire-and-forget): this handler is
        // terminal, so a void'd write could be dropped when the service worker
        // suspends right after the response is sent. recordLlmMetric swallows its
        // own errors and returns void, so awaiting can't fail the response.
        await recordLlmMetric({
          durationMs: Date.now() - startedAt,
          ok: result.ok,
          taskType,
          error: result.ok ? undefined : result.error,
          ...sample,
        });
        return result;
      })();
      activeChatCompletionJobs.add(completionJob);
      try {
        return await completionJob;
      } finally {
        activeChatCompletionJobs.delete(completionJob);
      }
    },
  },

  [MSG.cancelChatTurn]: {
    requiresExtensionPage: false,
    validate(msg) {
      return typeof msg.turnId === 'string' && msg.turnId ? null : 'missing turnId';
    },
    async handle(msg) {
      const controllers = activeChatRequests.get(msg.turnId);
      if (controllers) {
        for (const controller of controllers) controller.abort();
        activeChatRequests.delete(msg.turnId);
      }
      return { ok: true };
    },
  },

  // Records the outcome of one article-chat highlight_span tool call. The
  // classification happens page-side (in articleChat.js) but chat mounts in
  // content scripts too, so recording is centralized here in the worker.
  // Terminal handler: await the write so it is not dropped on SW suspension.
  [MSG.recordChatToolMetric]: {
    requiresExtensionPage: false,
    validate: () => null,
    async handle(msg) {
      await recordChatToolMetric({ outcome: msg.outcome, error: msg.error });
      return { ok: true };
    },
  },

  // Clearing runs in the worker (not the options realm) so it serializes on the
  // same writeChain as recordChatToolMetric — otherwise an in-flight worker
  // record could restore the pre-clear aggregate after an options-side clear.
  [MSG.clearChatToolMetrics]: {
    requiresExtensionPage: false,
    validate: () => null,
    async handle() {
      await clearChatToolMetrics();
      return { ok: true };
    },
  },

  // Parser and resplit samples are also produced in the worker. Route their
  // clears through this realm so each clear shares the same serialized metrics
  // queue as its in-flight record writes.
  [MSG.clearParserMetrics]: {
    requiresExtensionPage: false,
    validate: () => null,
    async handle() {
      await clearParserMetrics();
      return { ok: true };
    },
  },

  [MSG.clearResplitMetrics]: {
    requiresExtensionPage: false,
    validate: () => null,
    async handle() {
      await clearResplitMetrics();
      return { ok: true };
    },
  },

  [MSG.listChats]: {
    requiresExtensionPage: false,
    validate(msg) {
      return msg.key ? null : 'missing key';
    },
    async handle(msg) {
      return { ok: true, chats: await listChats(msg.key) };
    },
  },

  [MSG.getChat]: {
    requiresExtensionPage: false,
    validate(msg) {
      if (!msg.key) return 'missing key';
      if (!msg.chatId) return 'missing chatId';
      return isSafeChatId(msg.chatId) ? null : 'invalid chatId';
    },
    async handle(msg) {
      const chat = await readChat(msg.key, msg.chatId);
      return chat ? { ok: true, chat } : { ok: false, error: 'chat not found' };
    },
  },

  // Persists a whole LLM turn (messages + events) as one atomic write; a falsy
  // chatId creates the chat inline so a failed first turn leaves no orphan chat.
  [MSG.appendChatTurn]: {
    requiresExtensionPage: false,
    validate(msg) {
      if (!msg.key) return 'missing key';
      if (msg.chatId && !isSafeChatId(msg.chatId)) return 'invalid chatId';
      if (!msg.turn || typeof msg.turn !== 'object') return 'missing turn';
      const hasMessages = Array.isArray(msg.turn.messages) && msg.turn.messages.length > 0;
      const hasEvents = Array.isArray(msg.turn.events) && msg.turn.events.length > 0;
      return hasMessages || hasEvents ? null : 'empty turn';
    },
    async handle(msg) {
      const { chat } = await appendChatTurn(msg.key, msg.chatId, msg.turn);
      return { ok: true, chat };
    },
  },

  [MSG.deleteChat]: {
    requiresExtensionPage: false,
    validate(msg) {
      if (!msg.key) return 'missing key';
      if (!msg.chatId) return 'missing chatId';
      return isSafeChatId(msg.chatId) ? null : 'invalid chatId';
    },
    async handle(msg) {
      await deleteChatHistory(msg.key, msg.chatId);
      return { ok: true };
    },
  },

  [MSG.listProviders]: {
    requiresExtensionPage: true,
    validate: () => null,
    async handle() {
      const state = await getProvidersState();
      return { ok: true, ...sanitizeProvidersState(state) };
    },
  },

  [MSG.saveProvider]: {
    requiresExtensionPage: true,
    validate: () => null,
    async handle(msg) {
      const provider = await saveProvider(msg.provider);
      const state = await getProvidersState();
      return { ok: true, provider: sanitizeProvider(provider), ...sanitizeProvidersState(state) };
    },
  },

  [MSG.deleteProvider]: {
    requiresExtensionPage: true,
    validate(msg) {
      return msg.id ? null : 'missing id';
    },
    async handle(msg) {
      const state = await deleteProvider(msg.id);
      return { ok: true, ...sanitizeProvidersState(state) };
    },
  },

  [MSG.setActiveProvider]: {
    requiresExtensionPage: true,
    validate(msg) {
      return msg.id ? null : 'missing id';
    },
    async handle(msg) {
      const state = await setActiveProvider(msg.id);
      return { ok: true, ...sanitizeProvidersState(state) };
    },
  },
};

/**
 * Pure dispatch function. Owns: unknown-type handling, extension-page sender
 * gating, per-handler validation, and try/catch wrapping. Always resolves.
 *
 * Precondition: msg is non-null and has a non-empty `type` field.
 * (The `no type` short-circuit is the listener's responsibility so it can
 * return `false` synchronously in that case.)
 *
 * @param {object} msg
 * @param {object} sender
 * @param {*} [handlers]
 * @returns {Promise<object>}
 */
export async function dispatchMessage(msg, sender, handlers = MESSAGE_HANDLERS) {
  const entry = Object.hasOwn(handlers, msg.type) ? handlers[msg.type] : undefined;
  if (!entry) {
    return { ok: false, error: 'unknown type: ' + msg.type };
  }

  if (entry.requiresExtensionPage && !isExtensionPageSender(sender)) {
    return { ok: false, error: 'provider settings are only available to extension pages' };
  }

  const validationError = entry.validate(msg);
  if (validationError) {
    return { ok: false, error: validationError };
  }

  try {
    return await entry.handle(msg, sender);
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) {
    sendResponse({ ok: false, error: 'no type' });
    return false;
  }

  // Two-arg form on purpose: a trailing .catch would also catch a throw from
  // sendResponse itself and then call it a second time, so a failed send would
  // rethrow into an unhandled rejection and leave the sender hanging.
  dispatchMessage(msg, sender).then(sendResponse, (err) => {
    sendResponse({ ok: false, error: (err && err.message) || String(err) });
  });

  return true;
});

/**
 * Reconciles storage against the in-memory job registry: any record still in an
 * in-flight status is (re)started and the keepalive alarm is (re)armed. The
 * job registry does not survive service-worker termination, and the keepalive
 * alarm can be lost across a browser restart or extension update, so this scan
 * is what repairs records that would otherwise be orphaned mid-pipeline (see
 * onStartup/onInstalled below). startPipeline dedupes against the registry, so
 * calling this when jobs are already healthy is a no-op.
 */
async function resumeInFlightRecords() {
  let items;
  try {
    items = await listRecords();
  } catch (err) {
    resumeLog.warn('scan failed:', err);
    return;
  }
  const inFlight = (Array.isArray(items) ? items : []).filter(isInFlightRecord);
  if (inFlight.length === 0) return;
  scheduleKeepAlive();
  for (const rec of inFlight) {
    startPipeline(rec.key).catch((err) => {
      resumeLog.error('failed for', rec.key, err);
    });
  }
}

// Resume orphaned in-flight records when the browser starts or the extension is
// installed/updated — the two events that can drop the keepalive alarm the
// running-pipeline resume otherwise depends on. Guarded because not every
// runtime (or test harness) exposes these events.
if (chrome.runtime?.onStartup?.addListener) {
  chrome.runtime.onStartup.addListener(() => {
    void resumeInFlightRecords();
  });
}
if (chrome.runtime?.onInstalled?.addListener) {
  chrome.runtime.onInstalled.addListener(() => {
    void resumeInFlightRecords();
  });
}

// Repair interrupted page/index writes before reconciling their dependent
// chats. Reconciliation rebuilds projections from authoritative record meta,
// including fields added by newer versions, so no separate schema migration is
// needed. Both routines are idempotent and share the global mutation queue with
// normal writes, so startup races cannot resurrect deleted data.
void (async () => {
  try {
    await reconcileRecordStorage();
    await reconcileChatStorage();
  } catch (err) {
    log.warn('storage reconciliation failed:', err);
  }
})();

void refreshActionProgressIcon();
