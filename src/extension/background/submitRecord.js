import {
  createQueuedRecord,
  PIPELINE_STAGE,
  PIPELINE_STATUS,
} from '../../shared/runtime/contracts.js';
import { createLogger } from '../../shared/runtime/log.js';
import { sha256Hex } from './summaryResolution.js';

function comparableCapturedText(value) {
  return String(value ?? '')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * Builds the submission entry point: dedupe by URL or content hash, reset a
 * reused record back to a queued state, persist it, then hand it to the
 * supervisor.
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

  /**
   * @param {object} submission
   * @param {string} [submission.html]
   * @param {string} [submission.sourceUrl]
   * @param {string[]} [submission.selectors]
   * @param {number} [submission.captureVersion]
   * @param {string} [submission.capturedText]
   * @returns {Promise<{ok: boolean, key: string, error: string}>}
   */
  return async function handleSubmit(submission) {
    const { html, sourceUrl, selectors, captureVersion, capturedText } = submission;
    if (!html) return { ok: false, error: 'missing html' };

    let existing = null;
    if (sourceUrl) {
      existing = await findRecordByUrl(sourceUrl);
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
      // other mutation path guards that with the run-id CAS; writeRecord has
      // none by design (import must be able to write unconditionally), so the
      // reuse path borrows updateRecord's guard instead.
      const patch = {
        pipelineRunId,
        status: PIPELINE_STATUS.PENDING,
        error: null,
        progress: { stage: PIPELINE_STAGE.QUEUED, done: 0, total: 0 },
        sourceUrl: sourceUrl || existing.sourceUrl,
        html,
        captureVersion: Number.isInteger(captureVersion) ? captureVersion : null,
        capturedText: typeof capturedText === 'string' ? capturedText : null,
        processingLog: [],
        skipSummaries,
        // A submission for a non-terminal URL replaces its HTML and therefore
        // invalidates every checkpoint derived from the previous content. Keep
        // this in sync with reprocessRecord: retry may otherwise mistake the old
        // topics/sentences for a checkpoint belonging to this new revision.
        topics: [],
        topic_summaries: {},
        topic_summary_index: {},
        source_summary_units: {},
        sentences: [],
        text: '',
        summaryErrors: [],
        forceFinalize: false,
        acceptedMergeFailurePaths: [],
        summaryCheckpointContentRevision: null,
        summaryCheckpointPreferContentLanguage: null,
        summariesIncomplete: false,
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
      await writeRecord(
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
      );
    }

    // Start the pipeline in the background; do not await.
    pipelineSupervisor.startPipeline(key).catch((err) => {
      backgroundLog.error('startPipeline failed:', err);
    });

    return { ok: true, key };
  };
}
