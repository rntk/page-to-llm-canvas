import {
  createQueuedRecord,
  PIPELINE_STAGE,
  PIPELINE_STATUS,
} from '../../shared/runtime/contracts.js';
import { createLogger } from '../../shared/runtime/log.js';
import { sha256Hex } from './summaryResolution.js';

/**
 * Builds the submission entry point: dedupe by URL or content hash, reset a
 * reused record back to a queued state, persist it, then hand it to the
 * supervisor.
 *
 * @param {object} deps
 * @param {{readRecord: Function, writeRecord: Function, findRecordByUrl: Function}} deps.recordRepository
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
  const { readRecord, writeRecord, findRecordByUrl } = recordRepository;
  const backgroundLog = logger.child('background');

  /**
   * @param {object} submission
   * @param {string} [submission.html]
   * @param {string} [submission.sourceUrl]
   * @param {string[]} [submission.selectors]
   * @returns {Promise<{ok: boolean, key: string, error: string}>}
   */
  return async function handleSubmit(submission) {
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
      const hex = await hashContent(html);
      key = hex.slice(0, 32);
      existing = await readRecord(key);
    }

    if (existing && existing.status === PIPELINE_STATUS.DONE) {
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
    pipelineSupervisor.startPipeline(key).catch((err) => {
      backgroundLog.error('startPipeline failed:', err);
    });

    return { ok: true, key };
  };
}
