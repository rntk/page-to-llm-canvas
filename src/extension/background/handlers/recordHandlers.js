import { TOPIC_SOURCE_IDS } from '../../../shared/runtime/topicSources.js';
import { MSG } from '../../../shared/runtime/messages.js';
import {
  IN_FLIGHT_PIPELINE_STATUSES,
  isInFlightPipelineStatus,
  isSummaryGenerationSourceStatus,
  PIPELINE_STATUS,
  SUMMARY_GENERATION_SOURCE_STATUSES,
} from '../../../shared/runtime/contracts.js';
import { createLogger } from '../../../shared/runtime/log.js';
import { SUMMARY_TREE_STATUS } from '../../../shared/runtime/summaryTree.js';
import { decodeImportedRecords } from '../../../shared/runtime/recordImport.js';
import {
  cancelledTransition,
  queuedTransition,
  resetContentCheckpointPatch,
  resetSummaryReviewPatch,
  RESPLIT_CANCELLED_NOTICE,
  restoreAfterResplitPatch,
  resumeSummariesTransition,
  runInstructionsPatch,
  splittingTransition,
} from '../../../shared/runtime/recordTransitions.js';
import { clearSummaryErrorFlags, getAcceptedMergeFailurePaths } from '../summaryResolution.js';
import { canonicalTopicPath } from '../../../shared/runtime/topicPath.js';
import { validateResplitTarget } from '../../../core/pipeline/topicResplitApply.js';
import { normalizeCustomInstructions } from '../../../core/pipeline/customInstructions.js';

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
 * @param {{start: Function, stop: Function}} [deps.summaryTreeJobs] Summary tree builds.
 * @param {{get: Function, cancel: Function}} [deps.topicTagClouds] On-demand topic tag clouds.
 * @param {object} [deps.logger]
 */
export function createRecordHandlers({
  recordRepository,
  handleSubmit,
  pipelineSupervisor,
  getStoredSummariesDisabled,
  summaryCheckpoint,
  summaryTreeJobs = null,
  topicTagClouds = null,
  logger = createLogger(),
}) {
  const {
    readRecord,
    readRecordView,
    updateRecord,
    listRecords,
    writeRecord,
    deleteRecord,
    deleteAll,
  } = recordRepository;

  // Dispatcher converts this error into an `{ ok: false }` response.
  const requireRecord = async (key) => {
    const rec = await readRecord(key);
    if (!rec) throw new Error('record not found');
    return rec;
  };
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

  // Claim the next run before cancelling the run this snapshot observed, so a
  // stale claimant neither cancels nor restarts the winning run.
  // A running summary tree belongs to topics this claim replaces, so stop it
  // first (cancelling requires the record to still be `done`). `stop` also
  // covers a stored `running` tree with no in-memory job (after a worker
  // restart); the claim re-asserts the cancel in case a late checkpoint write
  // reopened it, so recovery cannot resume it against stale topic boundaries.
  const claimAndRestart = async (key, scope, patch, options) => {
    let claim = patch;
    if (summaryTreeJobs) {
      await summaryTreeJobs.stop(key);
      const latest = await readRecord(key);
      const tree = latest?.summary_tree;
      if (tree?.status === SUMMARY_TREE_STATUS.RUNNING && !Object.hasOwn(patch, 'summary_tree')) {
        claim = {
          ...patch,
          summary_tree: {
            ...tree,
            status: SUMMARY_TREE_STATUS.CANCELLED,
            error: 'Stopped.',
            updatedAt: Date.now(),
          },
        };
      }
    }
    const updated = await updateRecord(key, claim, options);
    if (!updated) return { ok: true, stale: true };
    cancelActivePipeline(key, { expectedPipelineRunId: options.expectedPipelineRunId });
    restart(key, scope);
    return { ok: true };
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

    [MSG.retryRecord]: {
      requiresExtensionPage: false,
      validate: requireKey,
      async handle(msg) {
        const rec = await requireRecord(msg.key);
        // Retry an unfinished manual resplit from its saved intent. Otherwise
        // a failure may follow a persisted topic checkpoint and summaries, so
        // resume summarizing only when the whole checkpoint is safe; else do a
        // fresh run. Reprocess is the explicitly destructive operation.
        const resumesSummaries =
          isSummaryCheckpointRevisionCurrent(rec) && isSummaryCheckpointComplete(rec);
        const retriesResplit = Boolean(rec.manualResplitIntent);
        // Skip/force-finalize directives belong to the saved checkpoint: dropping
        // them would re-run merge work the user accepted. Meaningless on a fresh run.
        const forceFinalize = resumesSummaries && rec.forceFinalize === true;
        const acceptedMergeFailurePaths =
          forceFinalize && Array.isArray(rec.acceptedMergeFailurePaths)
            ? rec.acceptedMergeFailurePaths
            : [];
        return claimAndRestart(
          msg.key,
          'retryRecord',
          {
            pipelineRunId: createPipelineRunId(),
            manualResplitIntent: retriesResplit ? rec.manualResplitIntent : null,
            ...(retriesResplit
              ? splittingTransition()
              : resumesSummaries
                ? resumeSummariesTransition({
                    total: rec.topics.length,
                    forceFinalize,
                    acceptedMergeFailurePaths,
                  })
                : // A fresh run has nothing to carry: `forceFinalize` and
                  // `acceptedMergeFailurePaths` are already false/[] here.
                  { ...queuedTransition(), ...resetSummaryReviewPatch() }),
            // A resumed checkpoint must finish its paid-for summaries; a newly
            // enabled global "skip summaries" would clear them. Fresh retries
            // keep the directive from submission.
            skipSummaries: resumesSummaries && !retriesResplit ? false : rec.skipSummaries === true,
          },
          { expectedPipelineRunId: rec.pipelineRunId },
        );
      },
    },

    [MSG.reprocessRecord]: {
      requiresExtensionPage: false,
      validate: requireKey,
      async handle(msg) {
        const rec = await requireRecord(msg.key);
        return claimAndRestart(
          msg.key,
          'reprocessRecord',
          {
            pipelineRunId: createPipelineRunId(),
            ...queuedTransition(),
            ...resetContentCheckpointPatch(),
            processingLog: [],
            skipSummaries: await getStoredSummariesDisabled(),
          },
          {
            bumpContentRevision: true,
            expectedPipelineRunId: rec.pipelineRunId,
          },
        );
      },
    },

    // Generates or completes summaries for a processed record without redoing
    // earlier stages: re-enters 'summarizing' with an explicit "summaries on"
    // directive, so the orchestrator's resume path queries only missing/failed ones.
    [MSG.generateRecordSummaries]: {
      requiresExtensionPage: false,
      validate: requireKey,
      async handle(msg) {
        const rec = await requireRecord(msg.key);
        // Resumes a terminal record's checkpoint; must not replace an active
        // pipeline that may still be building it.
        if (!isSummaryGenerationSourceStatus(rec.status)) {
          return { ok: true, stale: true };
        }
        // Reject before changing status or cancelling work: malformed imports can
        // have non-empty arrays whose topic references still cannot be summarized.
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
        return claimAndRestart(
          msg.key,
          'generateRecordSummaries',
          {
            pipelineRunId: createPipelineRunId(),
            manualResplitIntent: null,
            resplitNotice: null,
            ...resumeSummariesTransition({ total: rec.topics.length }),
            // Explicit intent: this run generates summaries even while the global
            // "disable summaries" toggle is on.
            skipSummaries: false,
          },
          {
            expectedPipelineRunId: rec.pipelineRunId,
            expectedStatuses: [...SUMMARY_GENERATION_SOURCE_STATUSES],
          },
        );
      },
    },

    [MSG.resplitTopic]: {
      requiresExtensionPage: false,
      validate: requireKey,
      async handle(msg) {
        const rec = await requireRecord(msg.key);
        if (rec.status !== PIPELINE_STATUS.DONE) {
          if (isInFlightPipelineStatus(rec.status)) return { ok: true, stale: true };
          if (rec.status === PIPELINE_STATUS.NEEDS_ATTENTION) {
            return { ok: false, error: 'record needs attention — resolve it before resplitting' };
          }
          return { ok: false, error: 'record is not complete — retry or reprocess it first' };
        }
        if (!isSummaryCheckpointComplete(rec) || !isSummaryCheckpointRevisionCurrent(rec)) {
          return {
            ok: false,
            error: 'record topic checkpoint is incomplete or stale — reprocess the record first',
          };
        }
        const target = {
          path: msg.path,
          startSentence: msg.startSentence,
          endSentence: msg.endSentence,
        };
        const invalidTarget = validateResplitTarget(rec, target);
        if (invalidTarget) return { ok: false, error: invalidTarget };
        return claimAndRestart(
          msg.key,
          'resplitTopic',
          {
            pipelineRunId: createPipelineRunId(),
            ...splittingTransition(),
            resplitNotice: null,
            manualResplitIntent: {
              ...target,
              path: canonicalTopicPath(target.path),
              // Restored if the resplit ends without replacing any topics.
              previousProgress: rec.progress,
            },
            // Persisted with the run claim so a resumed resplit keeps the
            // guidance; an unguided resplit stores null.
            ...runInstructionsPatch(
              normalizeCustomInstructions(msg.splittingInstructions),
              normalizeCustomInstructions(msg.summaryInstructions),
            ),
            // `skipSummaries` is left untouched: new subtopics are summarized
            // exactly when the rest of the record was.
          },
          {
            expectedPipelineRunId: rec.pipelineRunId,
            expectedStatuses: [PIPELINE_STATUS.DONE],
          },
        );
      },
    },

    // Builds the alternative summary tree beside a completed record's topics
    // and summaries. The record stays completed; `fresh` rebuilds instead of
    // resuming saved work.
    [MSG.buildSummaryTree]: {
      requiresExtensionPage: false,
      validate: requireKey,
      async handle(msg) {
        if (!summaryTreeJobs) return { ok: false, error: 'summary trees are unavailable' };
        const rec = await requireRecord(msg.key);
        if (rec.status !== PIPELINE_STATUS.DONE) {
          return { ok: false, error: 'record is not complete — wait for it to finish first' };
        }
        if (!isSummaryCheckpointComplete(rec) || !isSummaryCheckpointRevisionCurrent(rec)) {
          return {
            ok: false,
            error: 'record topic checkpoint is incomplete or stale — reprocess the record first',
          };
        }
        const started = await summaryTreeJobs.start(msg.key, { fresh: msg.fresh === true });
        return started ? { ok: true } : { ok: true, stale: true };
      },
    },

    [MSG.getTopicTagClouds]: {
      requiresExtensionPage: false,
      validate(msg) {
        if (typeof msg.key !== 'string' || !msg.key) return 'missing key';
        return TOPIC_SOURCE_IDS.includes(msg.source) ? null : 'unknown topic source';
      },
      async handle(msg) {
        if (!topicTagClouds) return { ok: false, error: 'Topic tag clouds are unavailable.' };
        return { ok: true, tagClouds: await topicTagClouds.get(msg.key, msg.source) };
      },
    },

    [MSG.stopSummaryTree]: {
      requiresExtensionPage: false,
      validate: requireKey,
      async handle(msg) {
        if (!(await summaryTreeJobs?.stop(msg.key))) return { ok: true, stale: true };
        return { ok: true };
      },
    },

    [MSG.cancelRecordProcessing]: {
      requiresExtensionPage: false,
      validate: requireKey,
      async handle(msg) {
        const rec = await requireRecord(msg.key);
        if (!isInFlightPipelineStatus(rec.status)) {
          return { ok: true, stale: true };
        }
        // Stopping a resplit before it replaced any topics returns the record
        // to its completed state; the saved checkpoint is still intact.
        const stopsResplit =
          Boolean(rec.manualResplitIntent) && rec.status === PIPELINE_STATUS.SPLITTING;
        let updated = await updateRecord(
          msg.key,
          {
            pipelineRunId: createPipelineRunId(),
            ...(stopsResplit
              ? restoreAfterResplitPatch(rec, RESPLIT_CANCELLED_NOTICE)
              : cancelledTransition()),
          },
          {
            expectedPipelineRunId: rec.pipelineRunId,
            // A finalizer keeps the same run id, so the queued write must also
            // verify that this record has not already reached a terminal state.
            expectedStatuses: stopsResplit
              ? [PIPELINE_STATUS.SPLITTING]
              : [...IN_FLIGHT_PIPELINE_STATUSES],
          },
        );
        if (!updated && stopsResplit) {
          // Replacement topics may have committed while Stop was queued.
          // Cancel their summaries without restoring the old completed state.
          updated = await updateRecord(
            msg.key,
            { pipelineRunId: createPipelineRunId(), ...cancelledTransition() },
            {
              expectedPipelineRunId: rec.pipelineRunId,
              expectedStatuses: [PIPELINE_STATUS.SUMMARIZING],
            },
          );
        }
        if (!updated) {
          return { ok: true, stale: true };
        }
        cancelActivePipeline(msg.key, { expectedPipelineRunId: rec.pipelineRunId });
        await pipelineSupervisor.clearPipelineFailuresForKey(msg.key);
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
        const rec = await requireRecord(msg.key);
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
          // A new run supersedes the outcome of any earlier Resplit.
          resplitNotice: null,
          // Resets the parked progress stage so the UI shows summarizing, not
          // 'needs_attention', before the worker's first write. Earlier Skip
          // acceptances stay active while only newly failed work is retried.
          ...resumeSummariesTransition({
            total: 0,
            forceFinalize:
              msg.action === 'skip' ||
              hasAcceptedLeafFailure ||
              carriedAcceptedMergePaths.length > 0,
            acceptedMergeFailurePaths: carriedAcceptedMergePaths,
          }),
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
          // The parked index holds empty runs for newly failed merge paths too;
          // reusing it would turn this Retry into a silent Skip. Force a fresh
          // merge; makeForceFinalizeSummarizer suppresses only the accepted paths.
          patch.topic_summary_index = {};
        }
        return claimAndRestart(msg.key, 'resolveSummaryErrors', patch, {
          // The patch derives from this snapshot, so only the first of competing
          // Retry/Skip decisions wins; its new run id fails the others' compare-and-swap.
          expectedPipelineRunId: rec.pipelineRunId,
        });
      },
    },

    [MSG.getRecord]: {
      requiresExtensionPage: true,
      validate: requireKey,
      async handle(msg) {
        const record = await readRecord(msg.key);
        if (!record) return { ok: false, code: 'not_found', error: 'record not found' };
        const runtimeState = await pipelineSupervisor.getPipelineFailures([record]);
        return {
          ok: true,
          record,
          pipelineFailure: runtimeState.failures[record.key] || null,
        };
      },
    },

    [MSG.getRecordView]: {
      requiresExtensionPage: false,
      validate: requireKey,
      async handle(msg) {
        const record = await readRecordView(msg.key);
        if (!record) return { ok: false, code: 'not_found', error: 'record not found' };
        const runtimeState = await pipelineSupervisor.getPipelineFailures([record]);
        return {
          ok: true,
          record,
          pipelineFailure: runtimeState.failures[record.key] || null,
        };
      },
    },

    [MSG.listRecords]: {
      requiresExtensionPage: true,
      validate: () => null,
      async handle() {
        const items = await listRecords();
        const runtimeState = await pipelineSupervisor.getPipelineFailures(items);
        return {
          ok: true,
          items,
          pipelineFailures: runtimeState.failures,
        };
      },
    },

    [MSG.importRecords]: {
      requiresExtensionPage: true,
      validate: () => null,
      async handle(msg) {
        const records = Array.isArray(msg.records) ? msg.records : [];
        if (records.length === 0) return { ok: false, error: 'no records to import' };

        const now = Date.now();
        let count = 0;
        for (const record of decodeImportedRecords(records, { now })) {
          try {
            await writeRecord(
              { ...record, pipelineRunId: createPipelineRunId() },
              { bumpContentRevision: true, keepRevisionWhenTextUnchanged: true },
            );
            count += 1;
            // Pipeline updates carry the old run id and cannot overwrite the
            // imported record. Cancel only after the replacement commits, so
            // a failed write leaves the existing run alone.
            cancelActivePipeline(record.key);
            await pipelineSupervisor.clearPipelineFailuresForKey(record.key);
          } catch (error) {
            // A batch is a sequence of independent writes. Completed records
            // stay imported; report them so the caller can refresh its list.
            return { ok: false, count, error: error?.message || String(error) };
          }
        }

        if (count === 0) return { ok: false, error: 'no valid records to import' };
        return { ok: true, count };
      },
    },

    [MSG.deleteRecord]: {
      requiresExtensionPage: true,
      validate: () => null,
      async handle(msg) {
        cancelActivePipeline(msg.key);
        topicTagClouds?.cancel(msg.key);
        await summaryTreeJobs?.stop(msg.key);
        await deleteRecord(msg.key);
        await pipelineSupervisor.clearPipelineFailuresForKey(msg.key);
        return { ok: true };
      },
    },

    [MSG.deleteAll]: {
      requiresExtensionPage: true,
      validate: () => null,
      async handle() {
        pipelineSupervisor.cancelAll();
        topicTagClouds?.cancel();
        await deleteAll();
        await pipelineSupervisor.clearPipelineFailuresForKey();
        return { ok: true };
      },
    },
  };
}
