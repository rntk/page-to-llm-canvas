import { createQueuedRecord, PIPELINE_STATUS } from '../../shared/runtime/contracts.js';
import {
  queuedTransition,
  resetContentCheckpointPatch,
} from '../../shared/runtime/recordTransitions.js';
import { createLogger } from '../../shared/runtime/log.js';
import { sha256Hex } from './summaryResolution.js';

function comparableCapturedText(value) {
  return String(value ?? '')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * Builds the submission entry point: dedupe by URL + selection or content
 * hash, reset a reused record back to a queued state, persist it, then hand
 * it to the supervisor.
 *
 * @param {object} deps
 * @param {{readRecord: Function, writeRecord: Function, updateRecord: Function, findRecordByUrl: Function}} deps.recordRepository
 * @param {function(): Promise<boolean>} deps.getStoredSummariesDisabled
 * @param {{startPipeline: Function, isActive: Function, createPipelineRunId: Function}} deps.pipelineSupervisor
 * @param {function(): number} [deps.clock]
 * @param {object} [deps.logger]
 * @param {function(string): Promise<string>} [deps.hashContent]
 */
export function createSubmitRecord({
  recordRepository,
  getStoredSummariesDisabled,
  pipelineSupervisor,
  clock = Date.now,
  logger = createLogger(),
  hashContent = sha256Hex,
}) {
  const { readRecord, writeRecord, updateRecord, findRecordByUrl } = recordRepository;
  const backgroundLog = logger.child('background');

  // Submissions run one at a time. Identity resolution (URL match, then content
  // hash), the read that decides create-vs-reuse, the mutation and the
  // synchronous startPipeline claim are separated by awaits, so two submissions
  // for the same page can otherwise interleave: both resolve to the same key
  // while the supervisor still reports it idle, both mint a run id, and the
  // second one's id lands on the record while the first one's job is the one
  // actually running — every later CAS from that job is then rejected and the
  // record is stranded in-flight. Serializing costs nothing here: the section
  // only touches storage, and the pipeline itself is started detached.
  let submissionQueue = Promise.resolve();
  function serializeSubmission(run) {
    // A rejected submission must not stall the ones behind it, so the chain
    // that later submissions await is the swallowed one.
    const result = submissionQueue.then(run, run);
    submissionQueue = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  /**
   * @param {object} submission
   * @param {string} [submission.html]
   * @param {string} [submission.sourceUrl]
   * @param {string[]} [submission.selectors]
   * @param {number} [submission.captureVersion]
   * @param {string} [submission.capturedText]
   * @returns {Promise<{ok: boolean, key: string, error: string}>}
   */
  async function submit(submission) {
    const { html, sourceUrl, selectors, captureVersion, capturedText } = submission;
    if (!html) return { ok: false, error: 'missing html' };

    let existing = null;
    if (sourceUrl) {
      // Selection-aware on purpose: one page can hold several independently
      // picked blocks, so a URL match only counts when it carries the same
      // selection (see findRecordByUrl). Matching on the URL alone would let a
      // second pick on the same page overwrite the first one's analysis.
      existing = await findRecordByUrl(sourceUrl, { selectors });
    }

    let key;
    if (existing) {
      key = existing.key;
    } else {
      const hex = await hashContent(html);
      key = hex.slice(0, 32);
      existing = await readRecord(key);
    }

    const hasCurrentCapture = captureVersion === 2 && typeof capturedText === 'string';
    const existingHasCurrentCapture =
      existing?.captureVersion === 2 && typeof existing?.capturedText === 'string';
    const comparableIncomingText = hasCurrentCapture ? comparableCapturedText(capturedText) : '';
    const sameCapturedContent = existing
      ? hasCurrentCapture &&
        existingHasCurrentCapture &&
        comparableCapturedText(existing.capturedText) === comparableIncomingText
      : false;
    if (existing && existing.status === PIPELINE_STATUS.DONE && sameCapturedContent) {
      // Refresh the browser snapshot and selectors without invalidating the
      // analysis when their canonical text is unchanged.
      const patch = {
        html,
        captureVersion,
        capturedText,
        ...(Array.isArray(selectors) ? { selectors } : {}),
      };
      if (Object.keys(patch).length > 0) {
        await updateRecord(key, patch, { expectedPipelineRunId: existing.pipelineRunId });
      }
      return { ok: true, key };
    }

    // If a job is already running (or starting) for this key, do not clobber it.
    if (pipelineSupervisor.isActive(key)) {
      return { ok: true, key };
    }

    const now = clock();
    const pipelineRunId = pipelineSupervisor.createPipelineRunId();
    // Whether this run generates summaries is decided here, at kickoff, from the
    // global toggle, and persisted on the record as a run directive. The
    // orchestrator only ever reads the record, so the decision survives mid-run
    // toggle flips and service-worker restarts (see runPipeline).
    const skipSummaries = await getStoredSummariesDisabled();
    if (existing) {
      // Reusing a record goes through updateRecord, not writeRecord: the read
      // above is separated from this write by awaits, so a retry/reprocess/Skip
      // issued from the options page can take the record over in between. Every
      // other mutation path guards that with the run-id CAS; writeRecord only
      // guards absence (import must be able to overwrite unconditionally), so
      // the reuse path borrows updateRecord's guard instead.
      const patch = {
        pipelineRunId,
        ...queuedTransition(),
        sourceUrl: sourceUrl || existing.sourceUrl,
        html,
        captureVersion: Number.isInteger(captureVersion) ? captureVersion : null,
        capturedText: typeof capturedText === 'string' ? capturedText : null,
        processingLog: [],
        skipSummaries,
        // A submission for a non-terminal URL replaces its HTML and therefore
        // invalidates every checkpoint derived from the previous content (the
        // same reset reprocessRecord applies): retry may otherwise mistake the
        // old topics/sentences for a checkpoint belonging to this new revision.
        ...resetContentCheckpointPatch(),
      };
      if (Array.isArray(selectors)) patch.selectors = selectors;
      const updated = await updateRecord(key, patch, {
        bumpContentRevision: true,
        expectedPipelineRunId: existing.pipelineRunId,
      });
      // Rejected CAS (or a record deleted since the read): another writer owns
      // this key and is starting its own run, so leave it alone — the same
      // answer the isActive guard above gives.
      if (!updated) return { ok: true, key };
    } else {
      // Create-if-absent, not a plain write: the absence observed above is
      // separated from this write by awaits, so a second submission for the
      // same key (or an import) can create the record in between. An
      // unconditional write would reset the winner's brand-new record and
      // leave its already-started run holding a stale run id, failing every
      // subsequent CAS. Storage re-checks absence inside the key's mutation
      // queue and rejects the loser.
      const created = await writeRecord(
        createQueuedRecord({
          key,
          sourceUrl: sourceUrl || '',
          html,
          selectors,
          captureVersion,
          capturedText,
          pipelineRunId,
          skipSummaries,
          now,
        }),
        { onlyIfAbsent: true },
      );
      // The winner owns this key and starts (or already started) its own run,
      // so acknowledge the same key without touching it — the same answer the
      // isActive and CAS-rejection guards give.
      if (!created) return { ok: true, key };
    }

    // Start the pipeline in the background; do not await.
    pipelineSupervisor.startPipeline(key).catch((err) => {
      backgroundLog.error('startPipeline failed:', err);
    });

    return { ok: true, key };
  }

  /**
   * @param {object} submission
   * @returns {Promise<{ok: boolean, key?: string, error?: string}>}
   */
  return function handleSubmit(submission) {
    return serializeSubmission(() => submit(submission));
  };
}
