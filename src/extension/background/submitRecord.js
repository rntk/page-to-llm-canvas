import { createQueuedRecord, PIPELINE_STATUS } from '../../shared/runtime/contracts.js';
import {
  queuedTransition,
  resetContentCheckpointPatch,
  runInstructionsPatch,
} from '../../shared/runtime/recordTransitions.js';
import { createLogger } from '../../shared/runtime/log.js';
import { sha256Hex } from './summaryResolution.js';
import { normalizeCustomInstructions } from '../../core/pipeline/customInstructions.js';

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

  // Submissions run one at a time: identity resolution, the create-vs-reuse
  // read, the write and the startPipeline claim span awaits, so two submissions
  // for one page could interleave and the second's run id would land on the
  // record while the first's job runs, failing every CAS and stranding the
  // record in-flight. Cheap: only storage is touched; the pipeline starts detached.
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
   * @param {string} [submission.splittingInstructions]
   * @param {string} [submission.summaryInstructions]
   * @returns {Promise<{ok: boolean, key: string, error: string}>}
   */
  async function submit(submission) {
    const { html, sourceUrl, selectors, captureVersion, capturedText } = submission;
    const splittingInstructions = normalizeCustomInstructions(submission.splittingInstructions);
    const summaryInstructions = normalizeCustomInstructions(submission.summaryInstructions);
    if (!html) return { ok: false, error: 'missing html' };

    let existing = null;
    if (sourceUrl) {
      // Selection-aware: one page can hold several picked blocks, so a URL match
      // counts only with the same selection (see findRecordByUrl); otherwise a
      // second pick would overwrite the first's analysis.
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
    // Custom guidance belongs to one run only (see runInstructions), so a guided
    // submission always reruns the analysis instead of comparing against it.
    const hasInstructions = Boolean(splittingInstructions || summaryInstructions);
    if (
      existing &&
      existing.status === PIPELINE_STATUS.DONE &&
      sameCapturedContent &&
      !hasInstructions
    ) {
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
    // Decided at kickoff from the global toggle and persisted as a run directive,
    // so it survives mid-run toggle flips and worker restarts (see runPipeline).
    const skipSummaries = await getStoredSummariesDisabled();
    if (existing) {
      // updateRecord, not writeRecord: a retry/reprocess/Skip can take the record
      // over between the read and this write, and only updateRecord has the run-id CAS.
      const patch = {
        pipelineRunId,
        ...queuedTransition(),
        sourceUrl: sourceUrl || existing.sourceUrl,
        html,
        captureVersion: Number.isInteger(captureVersion) ? captureVersion : null,
        capturedText: typeof capturedText === 'string' ? capturedText : null,
        processingLog: [],
        skipSummaries,
        // New HTML invalidates checkpoints from the old content (as in
        // reprocessRecord); retry could otherwise reuse stale topics/sentences.
        ...resetContentCheckpointPatch(),
        ...runInstructionsPatch(splittingInstructions, summaryInstructions),
      };
      if (Array.isArray(selectors)) patch.selectors = selectors;
      const updated = await updateRecord(key, patch, {
        bumpContentRevision: true,
        expectedPipelineRunId: existing.pipelineRunId,
      });
      // Rejected CAS (or deleted since the read): another writer owns this key.
      if (!updated) return { ok: true, key };
    } else {
      // Create-if-absent: a concurrent submission or import may create the record
      // after the absence check; an unconditional write would give the winner's
      // running job a stale run id. Storage rechecks inside its mutation queue.
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
          ...runInstructionsPatch(splittingInstructions, summaryInstructions),
          now,
        }),
        { onlyIfAbsent: true },
      );
      // The winner owns this key and starts its own run.
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
