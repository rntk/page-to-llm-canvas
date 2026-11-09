// Service-worker pipeline: prepare source, split topics, resume or generate summaries.

import { formatPipelineError } from './pipelineRuntime.js';
import { computeTopics } from '../../../core/pipeline/topicRangesStage.js';
import { resplitTopicRange } from '../../../core/pipeline/topicRangeResplit.js';
import {
  applyTopicResplit,
  validateResplitTarget,
} from '../../../core/pipeline/topicResplitApply.js';
import { groupsToTopics } from '../../../core/pipeline/topicRangeMapping.js';
import { splitTopicPath } from '../../../shared/runtime/topicPath.js';
import { finalizeSummariesDisabled, runSummaries } from '../../../core/pipeline/summaryStage.js';
import { reacceptForcedEmptySummaries } from '../../../core/pipeline/summaryRunMarkers.js';
import { isCancellationError } from '../../../core/pipeline/cancellation.js';
import { PIPELINE_STAGE, PIPELINE_STATUS } from '../../../shared/runtime/contracts.js';
import {
  errorTransition,
  resetSummaryReviewPatch,
  RESPLIT_NO_CHANGE_NOTICE,
  restoreAfterResplitPatch,
  summarizingTransition,
} from '../../../shared/runtime/recordTransitions.js';
import { createPipelineProviderServices } from './pipelineProviders.js';
import {
  runSummaryTree as runSummaryTreeStage,
  SUMMARY_TREE_STATUS,
  SUMMARY_TREE_VERSION,
} from '../../../core/pipeline/summaryTreeStage.js';
import { createArticleStrategy } from '../../../core/pipeline/summaryTreeStrategy.js';
import { PASSAGE_MAX_CHARS } from '../../../core/pipeline/summaryTreePassages.js';
import { normalizeCustomInstructions } from '../../../core/pipeline/customInstructions.js';
import { createProjectStrategy } from '../../../core/projects/projectTopicStrategy.js';
import {
  buildProjectTopicSeed,
  prepareIncrementalProjectTree,
  projectTopicSourceRevision,
} from '../../../core/projects/projectTopicTree.js';
import {
  getCustomInstructionsTextChunkMaxChars,
  MAX_TAGGED_CHARS,
} from '../../../core/pipeline/pipelineConfig.js';

// Reject malformed topics or missing sentence references without erasing saved
// summaries. Empty topics may coexist with valid ones, but at least one topic
// must resolve to nonblank source text.
export function isSummaryCheckpointComplete(record) {
  if (!Array.isArray(record?.topics) || record.topics.length === 0) return false;
  if (!Array.isArray(record.sentences) || record.sentences.length === 0) return false;
  const sentenceCount = record.sentences.length;
  const hasSourceText = (oneIdx) => {
    const text = record.sentences[oneIdx - 1];
    return typeof text === 'string' && text.trim() !== '';
  };

  let summarizableTopics = 0;
  for (const topic of record.topics) {
    if (typeof topic?.name !== 'string' || topic.name.trim() === '') return false;
    if (!Array.isArray(topic.sentences)) return false;
    if (
      !topic.sentences.every(
        (oneIdx) => Number.isInteger(oneIdx) && oneIdx >= 1 && oneIdx <= sentenceCount,
      )
    ) {
      return false;
    }
    if (topic.sentences.some(hasSourceText)) summarizableTopics++;
  }
  return summarizableTopics > 0;
}

/**
 * Reuse a summary checkpoint only when its revision matches current content.
 *
 * @param {object} record
 * @returns {boolean}
 */
export function isSummaryCheckpointRevisionCurrent(record) {
  const contentRevision = record?.contentRevision;
  const checkpointRevision = record?.summaryCheckpointContentRevision;
  return (
    typeof contentRevision === 'string' &&
    contentRevision !== '' &&
    typeof checkpointRevision === 'string' &&
    checkpointRevision !== '' &&
    checkpointRevision === contentRevision
  );
}

/**
 * Classify resume before side effects. Preserve malformed current checkpoints
 * for explicit reprocessing; rebuild stale checkpoints from source.
 *
 * @param {object} record
 * @returns {{resuming: boolean, rejectionReason: string|null}}
 */
export function planResume(record) {
  const isSummarizing = record?.status === PIPELINE_STATUS.SUMMARIZING;
  const hasCheckpointTopics =
    isSummarizing && Array.isArray(record?.topics) && record.topics.length > 0;
  const revisionCurrent = isSummaryCheckpointRevisionCurrent(record);
  const checkpointComplete = hasCheckpointTopics && isSummaryCheckpointComplete(record);
  // Preserve any current checkpoint, even with missing topics, for review.
  if (isSummarizing && revisionCurrent && !checkpointComplete) {
    return {
      resuming: false,
      rejectionReason: 'incomplete_checkpoint',
    };
  }
  return {
    resuming: revisionCurrent && checkpointComplete,
    rejectionReason: hasCheckpointTopics && !revisionCurrent ? 'content_revision_mismatch' : null,
  };
}

function sourceHost(sourceUrl) {
  try {
    return new URL(sourceUrl).hostname || 'Article';
  } catch (_) {
    return 'Article';
  }
}

/**
 * Creates one explicitly owned pipeline runner.
 *
 * Construction resolves the limiter once and installs the concurrency-setting
 * listener that mutates it. Call the runner once per realm, not once per run.
 * `dispose` reverses only that subscription; it deliberately neither resets nor
 * destroys an externally shared limiter, whose lifetime belongs to the
 * composition root and may include article-chat consumers.
 *
 * `limiterFactory` keeps limiter construction at the composition root. The
 * returned limiter may also gate other provider-facing surfaces (article chat)
 * so one setting controls the provider's aggregate concurrency.
 *
 * @param {object} deps
 * @param {Function} deps.runtimeFactory
 * @param {{getPreferContentLanguage: Function, getVerboseLogs: Function,
 *   getMaxParallelLlmRequests: Function, normalizeMaxParallelLlmRequests: Function,
 *   subscribeToMaxParallelLlmRequests: Function}} deps.settings
 * @param {{getActiveProvider: Function, getDecisionProvider: Function}} deps.providerRepository
 * @param {{callLLMWithRetry: Function, createDecisionClient: Function}} deps.llm
 *   `createDecisionClient(provider)` returns a client exposing `decide(state, questions, options)`.
 * @param {function(): {run: Function, setLimit: Function}} deps.limiterFactory
 *   Called exactly once per runner. A realm-level composition root may return
 *   its existing shared limiter; otherwise the factory may create one seeded
 *   with the same default the settings module normalizes towards.
 * @param {{wrapCallLLMWithRetry: Function, wrapDecide: Function}} deps.telemetry
 * @param {{info: Function, error: Function}} deps.logger
 * @returns {{runPipeline: Function, dispose: Function}}
 */
export function createPipelineRunner({
  runtimeFactory,
  settings,
  providerRepository,
  llm,
  limiterFactory,
  telemetry,
  logger,
}) {
  const limiter = limiterFactory();
  const bindProviders = createPipelineProviderServices({
    providerRepository,
    llm,
    telemetry,
    limiter,
  });
  let concurrencySettingRevision = 0;
  let disposed = false;
  const unsubscribe = settings.subscribeToMaxParallelLlmRequests((newValue) => {
    if (disposed) return;
    concurrencySettingRevision++;
    limiter.setLimit(settings.normalizeMaxParallelLlmRequests(newValue));
  });

  /**
   * Runs or resumes the persisted article-processing pipeline.
   *
   * @param {string} key
   * @param {object} [options]
   * @param {string} [options.pipelineRunId]
   * @param {AbortSignal} [options.signal]
   */
  async function runPipeline(key, options = {}) {
    const runtimeContext = {
      key,
      pipelineRunId: options.pipelineRunId,
      signal: options.signal,
      summariesDisabled: false,
    };
    // Keep a minimal runtime available so settings/provider bootstrap failures
    // still follow the normal pipeline error and logging path.
    let runtime = runtimeFactory(runtimeContext);
    // Record snapshot of a manual resplit that has not written its new topics yet.
    let pendingResplitRecord = null;

    const concurrencyRevisionAtRead = concurrencySettingRevision;
    try {
      const [
        preferContentLanguage,
        verboseLogs,
        maxParallelLlmRequests,
        decisionSplitThreshold,
        activeProvider,
      ] = await Promise.all([
        settings.getPreferContentLanguage(),
        settings.getVerboseLogs(),
        settings.getMaxParallelLlmRequests(),
        settings.getDecisionSplitThreshold(),
        // The provider snapshot sizes and handles every request in this run.
        // A missing provider remains an ordinary request-boundary error, but an
        // inability to read provider storage must retain its real cause.
        providerRepository.getActiveProvider(),
      ]);
      if (concurrencySettingRevision === concurrencyRevisionAtRead) {
        limiter.setLimit(maxParallelLlmRequests);
      }
      const providers = bindProviders({ activeProvider, key, verboseLogs });
      runtime = runtimeFactory({
        ...runtimeContext,
        preferContentLanguage,
        verboseLogs,
        decisionSplitThreshold,
        ...providers.runtimeOptions,
      });
      await runtime.log('pipeline_start');
      const record = await runtime.read();
      if (!record) throw new Error(`record not found: ${key}`);
      if (record.manualResplitIntent) pendingResplitRecord = record;
      // Guidance is a persisted run directive (like skipSummaries) so that
      // resume after service-worker recycling and Retry keep applying it.
      runtime.splittingInstructions = normalizeCustomInstructions(
        record.runInstructions?.splittingInstructions,
      );
      runtime.summaryInstructions = normalizeCustomInstructions(
        record.runInstructions?.summaryInstructions,
      );
      runtime.maxTextChunkChars = getCustomInstructionsTextChunkMaxChars(
        runtime.maxTextChunkChars ?? MAX_TAGGED_CHARS,
        runtime.splittingInstructions,
        runtime.summaryInstructions,
      );
      runtime.setSummariesDisabled(record.skipSummaries === true);

      // `topic_summaries` is the leaf checkpoint used to resume/retry summary
      // work after service-worker recycling; UI consumers read
      // `topic_summary_index` instead.
      const resumePlan = planResume(record);
      // A matching revision plus malformed structure is unsafe to consume and
      // must preserve the checkpoint for an explicit Reprocess decision.  A
      // A stale or missing revision is different: the saved topics are not proven
      // to belong to this content, so rebuild them through computeTopics rather
      // than displaying or summarizing stale data.
      const resuming = !record.manualResplitIntent && resumePlan.resuming;
      if (resumePlan.rejectionReason) {
        await runtime.log('pipeline_resume_rejected', {
          stage: PIPELINE_STAGE.SUMMARIZING,
          reason: resumePlan.rejectionReason,
          topicCount: Array.isArray(record.topics) ? record.topics.length : 0,
          sentenceCount: Array.isArray(record.sentences) ? record.sentences.length : 0,
        });
      }
      if (resumePlan.rejectionReason === 'incomplete_checkpoint') {
        throw new Error(
          'Cannot resume summaries because the saved sentence checkpoint is incomplete. Reprocess the record to rebuild it.',
        );
      }

      let topics;
      let sentenceTexts;
      // Summary work carried into this run: the saved checkpoint when resuming,
      // or the pruned checkpoint a manual resplit left behind. Null for a fresh
      // run, which starts from scratch.
      let carriedCheckpoint = null;
      let resplitForceFinalize = false;
      // Any run reusing saved summaries must retain their language policy.
      if (
        (resuming || record.manualResplitIntent) &&
        typeof record.summaryCheckpointPreferContentLanguage === 'boolean'
      ) {
        runtime.preferContentLanguage = record.summaryCheckpointPreferContentLanguage;
      }
      if (record.manualResplitIntent) {
        const intent = record.manualResplitIntent;
        // Until the new topics are written, the saved checkpoint is untouched;
        // any failure restores the record instead of marking it failed.
        pendingResplitRecord = record;
        sentenceTexts = record.sentences;
        const invalidTarget = validateResplitTarget(record, intent);
        if (invalidTarget) throw new Error(invalidTarget);
        await runtime.log('topic_resplit_start', {
          path: intent.path,
          startSentence: intent.startSentence,
          endSentence: intent.endSentence,
        });
        const groups = await resplitTopicRange(
          runtime,
          {
            label: splitTopicPath(intent.path),
            start: intent.startSentence - 1,
            end: intent.endSentence - 1,
          },
          sentenceTexts,
          providers.callLLMWithRetry,
        );
        const applied = applyTopicResplit(record, intent, groupsToTopics(groups), {
          invalidateAncestorSummaries: Boolean(runtime.summaryInstructions),
        });
        if (!applied) {
          await runtime.log('topic_resplit_no_change', { path: intent.path });
          await runtime.update(restoreAfterResplitPatch(record, RESPLIT_NO_CHANGE_NOTICE));
          return;
        }
        // Summaries skipped outside the selection stay skipped: re-arm them as
        // accepted failures so they are reused rather than retried, and let
        // force-finalize keep their sentences out of ancestor requests as the
        // original Skip did. Persisted so a restarted run resumes the same way.
        const { summaries: carriedSummaries, hasAcceptedFailure } = reacceptForcedEmptySummaries(
          applied.topic_summaries,
        );
        topics = applied.topics;
        carriedCheckpoint = { ...applied, topic_summaries: carriedSummaries };
        resplitForceFinalize = hasAcceptedFailure;
        await runtime.update({
          ...carriedCheckpoint,
          manualResplitIntent: null,
          resplitNotice: null,
          summaryCheckpointContentRevision: record.contentRevision,
          summaryCheckpointPreferContentLanguage: runtime.preferContentLanguage === true,
          ...resetSummaryReviewPatch(),
          forceFinalize: hasAcceptedFailure,
          ...summarizingTransition({ total: topics.length }),
        });
        pendingResplitRecord = null;
        await runtime.log('topic_resplit_done', {
          path: intent.path,
          replacementTopicCount: groups.length,
        });
      } else if (resuming) {
        topics = record.topics;
        sentenceTexts = record.sentences;
        carriedCheckpoint = record;
        const existingSummaries =
          record.topic_summaries && typeof record.topic_summaries === 'object'
            ? record.topic_summaries
            : {};
        await runtime.log('pipeline_resume', {
          stage: PIPELINE_STAGE.SUMMARIZING,
          topicCount: topics.length,
          existingSummaryCount: Object.keys(existingSummaries).length,
        });
        // Not `resumeSummariesTransition`: the handler that minted this run
        // already wrote the full transition (progress, Retry/Skip directives).
        // This only re-asserts the fields a restart could not have seen reset.
        await runtime.update({
          status: PIPELINE_STATUS.SUMMARIZING,
          error: null,
          summaryErrors: [],
          summariesIncomplete: false,
        });
      } else {
        const splitter = await providers.resolveTopicSplitter();
        await runtime.log('topic_splitter_selected', splitter.diagnostics);
        ({ topics, sentenceTexts } = await computeTopics({ runtime, record, splitter }));
        if (!topics) return;
      }

      if (runtime.summariesDisabled) {
        await finalizeSummariesDisabled(runtime, topics, {
          preserveExistingSummaries: carriedCheckpoint !== null,
        });
        return;
      }

      const carried = (field) =>
        carriedCheckpoint?.[field] && typeof carriedCheckpoint[field] === 'object'
          ? carriedCheckpoint[field]
          : {};
      const forceFinalize = resplitForceFinalize || (resuming && record.forceFinalize === true);
      const acceptedMergeFailurePaths =
        forceFinalize && Array.isArray(record.acceptedMergeFailurePaths)
          ? record.acceptedMergeFailurePaths
          : [];
      await runSummaries({
        runtime,
        topics,
        sentenceTexts,
        previousSummaries: carried('topic_summaries'),
        previousSummaryIndex: carried('topic_summary_index'),
        inputFingerprint: providers.summaryInputFingerprint,
        previousSourceSummaryUnits: carried('source_summary_units'),
        contentRevision:
          typeof record.contentRevision === 'string' && record.contentRevision
            ? record.contentRevision
            : null,
        forceFinalize,
        acceptedMergeFailurePaths,
        callLLMWithRetry: providers.callLLMWithRetry,
      });
    } catch (error) {
      if (isCancellationError(error, runtime)) {
        // A superseded run id or external cancel lands here; leave the record's
        // status alone (a newer run owns it) but log so it's not invisible.
        logger.info('aborted:', key, (error && error.message) || error);
        return;
      }

      const formattedError = formatPipelineError(error);
      if (pendingResplitRecord) {
        await runtime.log('topic_resplit_error', { error: formattedError }, { allowAborted: true });
        // A rejected write may still have committed: the replacement topics
        // before obsolete summary documents failed to delete, or a no-change
        // restore. Restore DONE only while storage still holds the unfinished
        // intent; a record already back at DONE needs nothing more.
        const persisted = await runtime.read().catch((readError) => {
          logger.error('failed to inspect record after resplit failure:', readError);
          return null;
        });
        if (persisted?.manualResplitIntent && persisted.status === PIPELINE_STATUS.SPLITTING) {
          try {
            await runtime.update(
              restoreAfterResplitPatch(pendingResplitRecord, `Resplit failed: ${formattedError}`),
              { allowAborted: true },
            );
            // Returning keeps the supervisor from overwriting the restored
            // record with ERROR.
            return;
          } catch (writeError) {
            // Fall through to ERROR; the kept intent lets Retry re-run it.
            logger.error('failed to restore record after resplit failure:', writeError);
          }
        } else if (persisted?.status === PIPELINE_STATUS.DONE) {
          return;
        }
      }
      // A provider failure can settle just after the signal aborts; let the
      // run-id CAS decide ownership instead of treating it as cancellation.
      await runtime.log('pipeline_error', { error: formattedError }, { allowAborted: true });
      await runtime
        .update(errorTransition(formattedError), { allowAborted: true })
        .catch((writeError) => {
          logger.error('failed to persist error status to storage:', writeError);
        });
      throw error;
    } finally {
      await runtime.flushLogs();
    }
  }

  // Setup shared by article and project summary trees. The fingerprint covers
  // the provider identity, so changing providers invalidates a saved tree.
  async function prepareSummaryTreeRun({ key }) {
    const revision = concurrencySettingRevision;
    const [verboseLogs, maxParallelLlmRequests, activeProvider] = await Promise.all([
      settings.getVerboseLogs(),
      settings.getMaxParallelLlmRequests(),
      providerRepository.getActiveProvider(),
    ]);
    if (revision === concurrencySettingRevision) limiter.setLimit(maxParallelLlmRequests);
    const providers = bindProviders({ activeProvider, key, verboseLogs });
    const judge = await providers.resolveSummaryTreeDecide();
    const fingerprint = JSON.stringify([
      providers.summaryInputFingerprint,
      activeProvider?.id ?? null,
      activeProvider?.url ?? null,
      activeProvider?.contextWindowTokens ?? null,
      judge.identity,
    ]);
    const maxChars = Math.min(PASSAGE_MAX_CHARS, providers.runtimeOptions.maxTextChunkChars);
    return { providers, judge, fingerprint, maxChars, verboseLogs };
  }

  // Marks the saved partial tree so the view offers a resume. Reads without the
  // stop signal: the record is still owned by this run.
  async function persistSummaryTreeFailure(runContext, { stopped, message }) {
    const owner = runtimeFactory(runContext);
    try {
      const latest = await owner.read();
      const tree = latest?.summary_tree;
      await owner.saveSummaryTree({
        version: SUMMARY_TREE_VERSION,
        ...(tree && typeof tree === 'object' ? tree : {}),
        status: stopped ? SUMMARY_TREE_STATUS.CANCELLED : SUMMARY_TREE_STATUS.ERROR,
        error: message,
        updatedAt: Date.now(),
      });
    } catch (writeError) {
      if (!isCancellationError(writeError, owner)) {
        logger.error('failed to persist summary tree failure:', writeError);
      }
    }
  }

  /**
   * Builds or resumes the summary tree of a completed record, beside its
   * primary topics and summaries. The record stays completed: the run owns it
   * only while its run id is current, so any newer pipeline run supersedes it.
   * Failures are stored on the tree, never on the record.
   *
   * @param {string} key
   * @param {object} [options]
   * @param {AbortSignal} [options.signal] User stop.
   * @param {boolean} [options.fresh] Rebuild instead of resuming a checkpoint.
   * @returns {Promise<void>}
   */
  async function runSummaryTree(key, options = {}) {
    const { signal, fresh = false } = options;
    let runtime = runtimeFactory({ key, signal });
    const record = await runtime.read();
    if (!record) throw new Error(`record not found: ${key}`);
    if (record.status !== PIPELINE_STATUS.DONE) {
      throw new Error('The record must finish processing before building a summary tree.');
    }
    const { providers, judge, fingerprint, verboseLogs } = await prepareSummaryTreeRun({ key });
    const runContext = {
      key,
      pipelineRunId: record.pipelineRunId,
      verboseLogs,
      ...providers.runtimeOptions,
    };
    runtime = runtimeFactory({ ...runContext, signal });
    try {
      if (judge.error)
        await runtime.log('summary_tree_decisions_unavailable', { error: judge.error });
      await runSummaryTreeStage({
        runtime,
        strategy: createArticleStrategy(record),
        callLLMWithRetry: providers.callLLMWithRetry,
        decide: judge.decide,
        decisionContextWindowTokens: judge.contextWindowTokens,
        fingerprint,
        rootTitle: sourceHost(record.sourceUrl),
        fresh,
      });
    } catch (error) {
      const lostRun = isCancellationError(error, runtime) && !signal?.aborted;
      if (lostRun) {
        logger.info('summary tree superseded:', key);
        return;
      }
      const stopped = signal?.aborted === true;
      const message = stopped ? 'Stopped.' : String(error?.message || error);
      await runtime.log(
        stopped ? 'summary_tree_stopped' : 'summary_tree_error',
        { error: message },
        { allowAborted: true },
      );
      await persistSummaryTreeFailure(runContext, { stopped, message });
      if (!stopped) logger.error('summary tree failed for', key, error);
    } finally {
      await runtime.flushLogs();
    }
  }

  // Projects share the pipeline's provider dispatch, limiter, citation checking,
  // and checkpoint protocol; they own a project document instead of a record.
  async function runProjectTopicTree({ records, prior, title, signal, fresh, saveSummaryTree }) {
    const sourceRevision = projectTopicSourceRevision(records);
    const { providers, judge, fingerprint, maxChars } = await prepareSummaryTreeRun({
      key: `project:${sourceRevision}`,
    });
    // A finished tree made by the same provider is extended with the pages that
    // changed instead of being grouped again from scratch.
    const incremental =
      !fresh && prior?.fingerprint === fingerprint
        ? prepareIncrementalProjectTree(prior, records, {
            contentRevision: sourceRevision,
            maxChars,
          })
        : null;
    const seed = incremental ? incremental.seed : buildProjectTopicSeed(records, { maxChars });
    return runSummaryTreeStage({
      runtime: {
        signal,
        ...providers.runtimeOptions,
        log: async (event, data) => logger.info(event, data),
        saveSummaryTree: (tree) =>
          saveSummaryTree({
            ...tree,
            sources: seed.sources,
            sentences: seed.sentences,
            records: seed.records,
            sourceRevision,
          }),
      },
      strategy: createProjectStrategy({
        seed,
        prior: incremental ? incremental.tree : prior,
        contentRevision: sourceRevision,
        extending: Boolean(incremental),
      }),
      callLLMWithRetry: providers.callLLMWithRetry,
      decide: judge.decide,
      decisionContextWindowTokens: judge.contextWindowTokens,
      fingerprint,
      rootTitle: title || 'Project topics',
      fresh,
    });
  }

  return {
    runPipeline,
    runSummaryTree,
    runProjectTopicTree,
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe?.();
    },
  };
}
