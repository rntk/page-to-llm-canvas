import { isInFlightStatus } from '../../../../worker/pipeline/pipelineStatus.js';
import { MSG } from '../../../shared/runtime/messages.js';
import {
  IN_FLIGHT_PIPELINE_STATUSES,
  isSummaryGenerationSourceStatus,
  isImportableRecord,
  PIPELINE_STAGE,
  PIPELINE_STATUS,
  SUMMARY_GENERATION_SOURCE_STATUSES,
} from '../../../shared/runtime/contracts.js';
import { createLogger } from '../../../shared/runtime/log.js';
import { clearSummaryErrorFlags, getAcceptedMergeFailurePaths } from '../summaryResolution.js';

/**
 * Handlers for the record lifecycle: submit, run control (retry / reprocess /
 * generate summaries / cancel / resolve errors), reads, import and delete.
 *
 * @param {object} deps
 * @param {object} deps.recordRepository readRecord/updateRecord/listRecords/writeRecord/deleteRecord/deleteAll
 * @param {Function} deps.handleSubmit
 * @param {object} deps.pipelineSupervisor
 * @param {function(): Promise<boolean>} deps.getStoredSummariesDisabled
 * @param {{isComplete: Function, isRevisionCurrent: Function}} deps.summaryCheckpoint
 * @param {object} [deps.logger]
 */
export function createRecordHandlers({
  recordRepository,
  handleSubmit,
  pipelineSupervisor,
  getStoredSummariesDisabled,
  summaryCheckpoint,
  logger = createLogger(),
}) {
  const { readRecord, updateRecord, listRecords, writeRecord, deleteRecord, deleteAll } =
    recordRepository;
  const {
    isComplete: isSummaryCheckpointComplete,
    isRevisionCurrent: isSummaryCheckpointRevisionCurrent,
  } = summaryCheckpoint;
  const { startPipeline, cancelActivePipeline, createPipelineRunId } = pipelineSupervisor;

  /**
   * Fire-and-forget restart used after a handler wins its compare-and-swap.
   * @param {string} key Record key to restart.
   * @param {string} scope Handler name, used to scope the failure log.
   */
  const restart = (key, scope) => {
    startPipeline(key).catch((err) => {
      logger.child(`${scope} startPipeline`).error('failed:', err);
    });
  };

  const requireKey = (msg) => (msg.key ? null : 'missing key');

  return {
    [MSG.submit]: {
      requiresExtensionPage: false,
      validate: () => null,
      async handle(msg) {
        return handleSubmit(msg);
      },
    },

    [MSG.ensurePipeline]: {
      requiresExtensionPage: false,
      validate: requireKey,
      async handle(msg) {
        await startPipeline(msg.key);
        return { ok: true };
      },
    },

    [MSG.retryRecord]: {
      requiresExtensionPage: false,
      validate: requireKey,
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
        restart(msg.key, 'retryRecord');
        return { ok: true };
      },
    },

    [MSG.reprocessRecord]: {
      requiresExtensionPage: false,
      validate: requireKey,
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
        restart(msg.key, 'reprocessRecord');
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
      validate: requireKey,
      async handle(msg) {
        const rec = await readRecord(msg.key);
        if (!rec) {
          return { ok: false, error: 'record not found' };
        }
        // This action resumes a terminal record's saved checkpoint. It must not
        // replace an active pipeline (which could still be building that
        // checkpoint) with a summaries-only run.
        if (!isSummaryGenerationSourceStatus(rec.status)) {
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
            progress: {
              stage: PIPELINE_STAGE.SUMMARIZING_TOPICS,
              done: 0,
              total: rec.topics.length,
            },
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
        restart(msg.key, 'generateRecordSummaries');
        return { ok: true };
      },
    },

    [MSG.cancelRecordProcessing]: {
      requiresExtensionPage: false,
      validate: requireKey,
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
        restart(msg.key, 'resolveSummaryErrors');
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
        pipelineSupervisor.cancelAll();
        await deleteAll();
        return { ok: true };
      },
    },
  };
}
